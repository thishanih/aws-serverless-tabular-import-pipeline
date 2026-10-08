# CSV Import Pipeline: 5-Million-Record Processing Design

An AWS CDK application for importing `.csv` files into DynamoDB. It includes an Express API that creates presigned URLs for browser-based CSV uploads.

## Import Paths

- **CSV:** S3 upload event -> Step Functions Distributed Map -> batched CSV validation and persistence -> DynamoDB.

CSV records are validated against the shared Zod schema. Invalid rows are written to private error files in S3, and completion summaries are sent through Amazon SES. The configured five-million-row CSV target has **not been load-tested** and is not a production throughput guarantee.

## Documentation

- [Pipeline architecture](docs/PIPELINE_ARCHITECTURE.md): components, data flow, handlers, and failure behavior.
- [Large CSV scaling](docs/LARGE_CSV_SCALING.md): batching design, limits, cost considerations, and load-testing guidance.
- [AWS setup and deployment](docs/AWS_DEPLOYMENT.md): credentials, SES setup, CDK bootstrap, deployment, and monitoring.
- [Step Functions workflow](docs/STEP_FUNCTIONS.md): file routing, execution behavior, and troubleshooting.

## Requirements

- Node.js 22 and npm.
- For AWS deployment: AWS CLI credentials with permission to deploy the stack, and a CDK-bootstrapped account and Region.
- A verified SES sender address and recipient address in the deployment Region. In SES sandbox mode, recipients must also be verified.

## Install and Run the Express API

Install dependencies and start the local API:

```sh
npm install
npm run dev
```

The API listens on `http://localhost:3000` by default. `GET /health` returns a health status.

The API provides `POST /uploads/presign` to create a five-minute presigned S3 upload URL for a CSV file. It expects JSON containing a `.csv` filename:

```sh
curl -X POST http://localhost:3000/uploads/presign \
  -H 'Content-Type: application/json' \
  -d '{"filename":"records.csv"}'
```

The response includes `uploadUrl`, the generated S3 `key`, and the required `Content-Type` header. Upload the CSV bytes to that URL with an HTTP `PUT`, using the returned headers.

Configure the local API with these environment variables:

- `UPLOADS_BUCKET`: deployed upload bucket name; required for presigning.
- `PORT`: API port; defaults to `3000`.
- `CORS_ORIGIN`: allowed browser origin; defaults to `*`.

The API uses the AWS SDK credential provider chain for S3 access. It does not automatically load `.env` files. For example, with an AWS CLI profile:

```sh
export AWS_PROFILE=excel-import-dev
export UPLOADS_BUCKET=UPLOAD_BUCKET_NAME
npm run dev
```

A successful `PUT` to the upload bucket starts the import automatically through the S3 object-created notification. Only `.csv` objects are processed.

## Input Format and Validation

The first row must contain these columns:

```text
name,email,contact number,address
```

CSV header names are trimmed and compared without regard to case.

Validation rules:

- `name` and `address` must not be empty after trimming.
- `email` must be a valid email address.
- `contact number` is stored as text. It may contain a leading `+`, digits, spaces, parentheses, periods, and hyphens, and must contain 7 to 15 digits.

Update [record-schema.ts](lambda/lib/record-schema.ts) if the business validation rules change.

## AWS Deployment

Use the organization's approved AWS access method. The detailed setup is in [AWS_DEPLOYMENT.md](docs/AWS_DEPLOYMENT.md). A typical deployment sequence is:

```sh
npm install
npm run build
npx cdk synth
npx cdk bootstrap aws://ACCOUNT_ID/REGION --profile excel-import-dev
npx cdk deploy --profile excel-import-dev \
  --parameters ExcelImportPipeline:NotificationEmail=recipient@example.com \
  --parameters ExcelImportPipeline:SesFromEmail=verified-sender@example.com
```

Replace the account, Region, profile, and email placeholders with your deployment values. The sender and recipient must be verified in SES in the deployment Region.

The stack outputs the upload bucket name, jobs table name, and state machine ARN. Upload a supported file to the upload bucket to start processing:

```sh
aws s3 cp ./records.csv s3://UPLOAD_BUCKET_NAME/records.csv \
  --profile excel-import-dev
```

Use a lowercase `.csv` suffix so the S3 notification routes the object to the workflow. Other file types do not start an import.

## CSV Capacity and Operational Notes

The CSV Distributed Map is configured for up to 1,000 rows or 128 KiB per batch, with maximum concurrency of 100. Each CSV object must be no larger than the Step Functions S3 ItemReader limit of 10 GB. The five-million-row target has not been load-tested; test with representative files and monitor duration, failures, throttling, and cost before production use.

Records are stored as individual DynamoDB items. Invalid CSV rows are stored as per-chunk CSV files in the private reports bucket, and the completion email links to a manifest. Downloading the report files requires AWS access to that bucket.

The S3 buckets and DynamoDB tables use retain policies. Destroying the CDK stack does not automatically delete those resources or their data. Review retention, access, monitoring, and recovery procedures before production use.

## Project Commands

```sh
npm run dev      # Run the local Express API with ts-node
npm start        # Run the compiled API from dist/server.js
npm run build    # TypeScript build
npm test         # Run Jest tests
npm run synth    # Build and synthesize the CDK stack
npm run deploy   # Build and deploy the CDK stack
```
