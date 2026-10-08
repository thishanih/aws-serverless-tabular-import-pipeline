# Excel Import Pipeline

The project also includes a standalone Express API for converting an uploaded `.xlsx` workbook to JSON and issuing presigned CSV upload URLs.

## Documentation

- [Lambda pipeline architecture](PIPELINE_ARCHITECTURE.md): component map, handler responsibilities, data flow, AWS resources, and failure behavior.
- [Large CSV processing](LARGE_CSV_SCALING.md): implemented 5-million-row CSV design, Zod rules, configuration, and untested capacity limits.
- [AWS setup and deployment](docs/AWS_DEPLOYMENT.md): account access, CDK bootstrap, deployment, upload, and monitoring steps.
- [Step Functions workflow](docs/STEP_FUNCTIONS.md): file routing, execution details, and troubleshooting.

## Express Excel-to-JSON API

```sh
npm install
npm run dev
```

The API listens on `http://localhost:3000` by default. Send the workbook bytes directly as the request body:

```sh
curl -X POST http://localhost:3000/convert \
	-H 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' \
	--data-binary @workbook.xlsx
```

The response contains the first worksheet name, row count, and JSON records. The first row supplies the property names; uploads are limited to 10 MB. `GET /health` checks whether the service is running.

The AWS CDK pipeline supports two import paths:

- `.xlsx`: `S3 -> Step Functions -> LoadWorkbook -> validation SQS -> ValidateRows -> persistence SQS -> PersistRows -> DynamoDB`
- `.csv`: `S3 -> Step Functions Distributed Map -> batched ProcessCsvBatch Lambda -> DynamoDB`, with per-chunk error CSVs in S3

Both paths validate `name`, `email`, `contact number`, and `address` with a shared Zod schema before writing valid records. Invalid XLSX rows are recorded in DynamoDB; invalid large-CSV rows are written to S3 error parts. Completion summaries are emailed through SES.

## Workbook format

Upload an `.xlsx` or `.csv` file to the generated upload bucket. The header row must contain `name`, `email`, `contact number`, and `address`. Zod requires non-empty name/address, a valid email, and a contact number containing 7-15 digits; contact numbers are stored as text and may include `+`, spaces, parentheses, periods, and hyphens.

## Deploy

Prerequisites: Node.js 22, AWS CLI credentials, an AWS CDK-bootstrapped account/region, and verified sender/recipient email identities in SES. SES sandbox accounts can send only to verified recipients.

```sh
npm install
npm run build
npx cdk bootstrap aws://ACCOUNT_ID/REGION
npx cdk deploy --parameters ExcelImportPipeline:NotificationEmail=recipient@example.com --parameters ExcelImportPipeline:SesFromEmail=verified-sender@example.com
```

The deployment outputs the upload bucket name, jobs table name, and state machine ARN. Uploading an `.xlsx` or `.csv` object starts a job. The notification recipient and sender are stack parameters.

To upload a CSV from a browser, run the Express service with AWS credentials and `UPLOADS_BUCKET` set to the deployed upload bucket name. Request a URL, then `PUT` the file bytes to it using the returned `Content-Type` header. The S3 object-created event starts the import automatically:

```js
const { uploadUrl, headers } = await fetch(
  "http://localhost:3000/uploads/presign",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name }),
  },
).then((response) => response.json());

await fetch(uploadUrl, { method: "PUT", headers, body: file });
```

CSV files must have a header row containing `name`, `email`, `contact number`, and `address`. The Distributed Map CSV path is configured for batches of at most 1,000 rows or 128 KiB, with concurrency capped at 100. Five-million-row capacity has not yet been load-tested. The XLSX path still buffers the workbook in Lambda memory.

## Notes

- This example loads the workbook into Lambda memory and sends one SQS message per row. For very large workbooks, replace the loader with an S3-backed streaming/chunking design; the 15-minute Lambda limit and SQS message/throughput limits apply.
- SQS consumers use partial batch responses and dead-letter queues. Inspect the DLQs and job table for rows that exhaust retries.
- DynamoDB tables and buckets are retained when the stack is deleted. Review data retention and access policies before production use.
- Completion email delivery uses SES and must be permitted by the account's sending limits and region configuration.
