import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as sqs from "aws-cdk-lib/aws-sqs";

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const uploads = new s3.Bucket(this, "Uploads", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 300,
        },
      ],
    });
    const reports = new s3.Bucket(this, "Reports", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const notificationEmail = new cdk.CfnParameter(this, "NotificationEmail", {
      type: "String",
      description: "Verified SES recipient email address.",
    });
    const sesFromEmail = new cdk.CfnParameter(this, "SesFromEmail", {
      type: "String",
      description:
        "Verified SES sender email address in the deployed AWS region.",
    });

    const jobs = new dynamodb.Table(this, "Jobs", {
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const records = new dynamodb.Table(this, "Records", {
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "rowNumber", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const errors = new dynamodb.Table(this, "ValidationErrors", {
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "rowNumber", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const chunkSummaries = new dynamodb.Table(this, "CsvChunkSummaries", {
      partitionKey: { name: "jobShard", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "chunkId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const validationDlq = new sqs.Queue(this, "ValidationDLQ", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const persistenceDlq = new sqs.Queue(this, "PersistenceDLQ", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const validationQueue = new sqs.Queue(this, "ValidationQueue", {
      visibilityTimeout: cdk.Duration.minutes(3),
      deadLetterQueue: { queue: validationDlq, maxReceiveCount: 5 },
    });
    const persistenceQueue = new sqs.Queue(this, "PersistenceQueue", {
      visibilityTimeout: cdk.Duration.minutes(3),
      deadLetterQueue: { queue: persistenceDlq, maxReceiveCount: 5 },
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      bundling: { minify: true, sourceMap: true },
    };
    const loader = new NodejsFunction(this, "LoadWorkbook", {
      ...common,
      entry: path.join(__dirname, "../lambda/handlers/load-workbook.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(15),
      memorySize: 2048,
      environment: {
        JOBS_TABLE: jobs.tableName,
        VALIDATION_QUEUE_URL: validationQueue.queueUrl,
        UPLOADS_BUCKET: uploads.bucketName,
      },
    });
    const createCsvJob = new NodejsFunction(this, "CreateCsvJob", {
      ...common,
      entry: path.join(__dirname, "../lambda/handlers/create-csv-job.ts"),
      handler: "handler",
      environment: { JOBS_TABLE: jobs.tableName },
    });
    const processCsvBatch = new NodejsFunction(this, "ProcessCsvBatch", {
      ...common,
      entry: path.join(__dirname, "../lambda/handlers/process-csv-batch.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(4),
      memorySize: 2048,
      environment: {
        CHUNK_SUMMARIES_TABLE: chunkSummaries.tableName,
        RECORDS_TABLE: records.tableName,
        REPORTS_BUCKET: reports.bucketName,
      },
    });
    const finalizeCsvJob = new NodejsFunction(this, "FinalizeCsvJob", {
      ...common,
      entry: path.join(__dirname, "../lambda/handlers/finalize-csv-job.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        JOBS_TABLE: jobs.tableName,
        CHUNK_SUMMARIES_TABLE: chunkSummaries.tableName,
        REPORTS_BUCKET: reports.bucketName,
        NOTIFICATION_EMAIL: notificationEmail.valueAsString,
        SES_FROM_EMAIL: sesFromEmail.valueAsString,
      },
    });

    const createCsvJobTask = new tasks.LambdaInvoke(this, "CreateCsvJobTask", {
      lambdaFunction: createCsvJob,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });
    const csvMap = new sfn.DistributedMap(this, "ProcessCsvRows", {
      itemReader: new sfn.S3CsvItemReader({
        bucket: uploads,
        key: sfn.JsonPath.stringAt("$.key"),
        csvHeaders: sfn.CsvHeaders.useFirstRow(),
      }),
      itemSelector: {
        "jobId.$": "$.jobId",
        "rowIndex.$": "$$.Map.Item.Index",
        "row.$": "$$.Map.Item.Value",
      },
      itemBatcher: new sfn.ItemBatcher({
        maxItemsPerBatch: 1000,
        maxInputBytesPerBatch: 128 * 1024,
      }),
      maxConcurrency: 100,
      mapExecutionType: sfn.StateMachineType.EXPRESS,
      resultWriterV2: new sfn.ResultWriterV2({
        bucket: reports,
        prefix: "csv-map-results",
        writerConfig: {
          transformation: sfn.Transformation.NONE,
          outputType: sfn.OutputType.JSONL,
        },
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    const processCsvBatchTask = new tasks.LambdaInvoke(
      this,
      "ProcessCsvBatchTask",
      {
        lambdaFunction: processCsvBatch,
        payloadResponseOnly: true,
      },
    );
    processCsvBatchTask.addRetry({
      errors: ["States.TaskFailed", "States.Timeout"],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    csvMap.itemProcessor(processCsvBatchTask, {
      mode: sfn.ProcessorMode.DISTRIBUTED,
      executionType: sfn.ProcessorType.EXPRESS,
    });
    const finalizeCsvJobTask = new tasks.LambdaInvoke(
      this,
      "FinalizeCsvJobTask",
      {
        lambdaFunction: finalizeCsvJob,
        payloadResponseOnly: true,
      },
    );
    const loadWorkbookTask = new tasks.LambdaInvoke(this, "CreateBatches", {
      lambdaFunction: loader,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    const definition = new sfn.Choice(this, "SelectFileProcessingPath")
      .when(
        sfn.Condition.stringMatches("$.key", "*.csv"),
        sfn.Chain.start(createCsvJobTask).next(csvMap).next(finalizeCsvJobTask),
      )
      .otherwise(loadWorkbookTask);
    const machine = new sfn.StateMachine(this, "ImportWorkflow", {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(6),
    });
    const start = new NodejsFunction(this, "StartWorkflow", {
      ...common,
      entry: path.join(__dirname, "../lambda/handlers/start-workflow.ts"),
      handler: "handler",
      environment: { STATE_MACHINE_ARN: machine.stateMachineArn },
    });
    machine.grantStartExecution(start);
    uploads.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(start),
      {
        suffix: ".xlsx",
      },
    );
    uploads.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(start),
      {
        suffix: ".csv",
      },
    );

    const handlerEnvironment = {
      JOBS_TABLE: jobs.tableName,
      ERRORS_TABLE: errors.tableName,
      REPORTS_BUCKET: reports.bucketName,
      NOTIFICATION_EMAIL: notificationEmail.valueAsString,
      SES_FROM_EMAIL: sesFromEmail.valueAsString,
    };
    const validator = new NodejsFunction(this, "ValidateRows", {
      ...common,
      entry: path.join(__dirname, "../lambda/handlers/validate-row.ts"),
      handler: "handler",
      environment: {
        ...handlerEnvironment,
        RECORDS_QUEUE_URL: persistenceQueue.queueUrl,
      },
    });
    const writer = new NodejsFunction(this, "PersistRows", {
      ...common,
      entry: path.join(__dirname, "../lambda/handlers/persist-row.ts"),
      handler: "handler",
      environment: { ...handlerEnvironment, RECORDS_TABLE: records.tableName },
    });

    uploads.grantRead(loader);
    jobs.grantReadWriteData(loader);
    validationQueue.grantSendMessages(loader);
    jobs.grantWriteData(createCsvJob);
    records.grantWriteData(processCsvBatch);
    chunkSummaries.grantReadWriteData(processCsvBatch);
    reports.grantPut(processCsvBatch);
    jobs.grantReadWriteData(finalizeCsvJob);
    chunkSummaries.grantReadData(finalizeCsvJob);
    reports.grantPut(finalizeCsvJob);
    reports.grantRead(finalizeCsvJob);
    jobs.grantReadWriteData(validator);
    errors.grantReadWriteData(validator);
    persistenceQueue.grantSendMessages(validator);
    jobs.grantReadWriteData(writer);
    records.grantReadWriteData(writer);
    errors.grantReadData(writer);
    reports.grantPut(writer);
    reports.grantRead(writer);
    reports.grantPut(validator);
    reports.grantRead(validator);
    for (const fn of [validator, writer, finalizeCsvJob]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: ["*"],
        }),
      );
    }
    validator.addEventSource(
      new events.SqsEventSource(validationQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
    writer.addEventSource(
      new events.SqsEventSource(persistenceQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    new cdk.CfnOutput(this, "UploadBucketName", { value: uploads.bucketName });
    new cdk.CfnOutput(this, "JobsTableName", { value: jobs.tableName });
    new cdk.CfnOutput(this, "StateMachineArn", {
      value: machine.stateMachineArn,
    });
  }
}
