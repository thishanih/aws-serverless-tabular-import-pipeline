# AWS Setup and Deployment

This guide deploys the `ExcelImportPipeline` CDK stack to an AWS account and region. For the workflow architecture, see [STEP_FUNCTIONS.md](STEP_FUNCTIONS.md).

## What the Stack Creates

The stack provisions upload and report S3 buckets, Lambda functions, a Step Functions state machine, an S3-backed Distributed Map for CSVs, SQS queues and dead-letter queues for XLSX rows, DynamoDB tables including sharded CSV chunk summaries, and SES email integration.

## Prerequisites

- Node.js 22 and npm.
- AWS CLI and AWS CDK credentials with permission to create the stack's resources.
- A region where the required AWS services are available.
- A verified SES sender address and recipient address in that region. SES sandbox accounts can send only to verified recipients.

Use your organization's approved AWS access method. IAM Identity Center/SSO or an assumed role is preferable to long-lived access keys. Never commit credentials or put real keys in `.env.example`.

## 1. Configure AWS Access

If your organization has not already configured an AWS CLI profile, create one using IAM Identity Center:

```sh
aws configure sso --profile excel-import-dev
```

Sign in and confirm which account the profile uses:

```sh
aws sso login --profile excel-import-dev
aws sts get-caller-identity --profile excel-import-dev
```

Choose the deployment region. Set it on the profile if it does not already have a default region:

```sh
aws configure set region us-east-1 --profile excel-import-dev
aws configure get region --profile excel-import-dev
```

Replace `us-east-1` with the region you intend to use. The account ID from `get-caller-identity` and this region form the CDK environment.

## 2. Verify SES Addresses

In the AWS console, switch to the deployment region and open Amazon SES. Verify both the sender address and recipient address. If SES is still in its sandbox, the recipient must also be verified. These addresses are supplied during stack deployment; they are not AWS credentials.

## 3. Install and Synthesize

From the project root, install dependencies and check the synthesized CloudFormation template:

```sh
npm ci
npm run build
npx cdk synth
```

Review the synthesized output and any CDK security approval prompts before deploying.

## 4. Bootstrap the Account and Region

CDK bootstrapping creates deployment resources used to publish Lambda assets and perform deployments. Bootstrap each account/region pair once:

```sh
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile excel-import-dev
```

Replace `ACCOUNT_ID` with the 12-digit account ID from step 1, and use the same region you configured on the profile. Bootstrapping creates resources in the AWS account and may incur charges.

## 5. Deploy the Stack

Provide the verified SES addresses as CloudFormation parameters:

```sh
npx cdk deploy --profile excel-import-dev \
  --parameters ExcelImportPipeline:NotificationEmail=recipient@example.com \
  --parameters ExcelImportPipeline:SesFromEmail=verified-sender@example.com
```

Review the proposed changes and approve the deployment when prompted. The stack injects table names, queue URLs, bucket names, and the state machine ARN into the relevant Lambda functions. Do not copy the placeholder Lambda values from `.env.example` into AWS.

When deployment completes, save the `UploadBucketName`, `JobsTableName`, and `StateMachineArn` outputs. You can display the stack outputs again with:

```sh
aws cloudformation describe-stacks \
  --stack-name ExcelImportPipeline \
  --profile excel-import-dev \
  --query 'Stacks[0].Outputs' \
  --output table
```

## 6. Upload a Workbook

The simplest test is uploading a workbook directly to the output upload bucket:

```sh
aws s3 cp ./workbook.xlsx s3://UPLOAD_BUCKET_NAME/workbook.xlsx \
  --profile excel-import-dev
```

Replace `UPLOAD_BUCKET_NAME` with the `UploadBucketName` stack output. The first row must contain `name`, `email`, `contact number`, and `address` headers. The S3 event starts Step Functions. XLSX files use the buffered loader and SQS path; CSV files use the S3-backed Distributed Map and batched Zod validation. The 5-million-row CSV target has not been load-tested, and one CSV object must be within the 10 GB Step Functions ItemReader limit.

For a direct S3 CSV upload:

```sh
aws s3 cp ./records.csv s3://UPLOAD_BUCKET_NAME/records.csv \
  --profile excel-import-dev
```

For a browser-based CSV upload, run the Express API locally with AWS access and the deployed bucket configured. This project does not automatically load `.env` files, so export the values in your shell:

```sh
export AWS_PROFILE=excel-import-dev
export UPLOADS_BUCKET=UPLOAD_BUCKET_NAME
npm run dev
```

The browser requests `POST http://localhost:3000/uploads/presign`, then uploads the CSV bytes with `PUT` to the returned URL using the returned `Content-Type` header. The CSV must also contain the required headers.

## 7. Monitor an Import

- In Step Functions, find the state machine using the `StateMachineArn` output and inspect executions, the CSV Map Run, and task failures.
- In Lambda, inspect logs for `StartWorkflow`, `LoadWorkbook`, `ProcessCsvBatch`, and `FinalizeCsvJob` as appropriate.
- XLSX processing continues asynchronously through the validation and persistence queues; check both queues, their DLQs, and the `Jobs`, `Records`, and `ValidationErrors` tables.
- CSV job totals are aggregated after the Map Run succeeds. Invalid CSV rows are stored as per-chunk CSVs in the private reports bucket; the email links to a manifest of those objects. Downloading the listed parts requires AWS access to the bucket.
- Completion emails are sent through SES. The existing XLSX error report link expires after seven days; the CSV manifest link also expires after seven days.

## Update or Remove the Stack

Compare changes before updating:

```sh
npx cdk diff --profile excel-import-dev
npx cdk deploy --profile excel-import-dev \
  --parameters ExcelImportPipeline:NotificationEmail=recipient@example.com \
  --parameters ExcelImportPipeline:SesFromEmail=verified-sender@example.com
```

To remove the CloudFormation stack:

```sh
npx cdk destroy ExcelImportPipeline --profile excel-import-dev
```

The upload and report buckets and DynamoDB tables use a retain policy. Destroying the stack does not automatically delete those resources or their data; review and remove retained resources manually if they are no longer needed.

## AWS References

- [Configure AWS environments for the CDK](https://docs.aws.amazon.com/cdk/v2/guide/configure-env.html)
- [AWS CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)
- [AWS CDK CLI reference](https://docs.aws.amazon.com/cdk/v2/guide/cli.html)
