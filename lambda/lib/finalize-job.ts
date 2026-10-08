import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ses = new SESv2Client({});

export async function finalizeJob(jobId: string): Promise<void> {
  const job = await db.send(
    new GetCommand({
      TableName: process.env.JOBS_TABLE,
      Key: { jobId },
      ConsistentRead: true,
    }),
  );
  if (
    !job.Item ||
    job.Item.completedRows !== job.Item.totalRows ||
    job.Item.status !== "PROCESSING"
  )
    return;

  try {
    await db.send(
      new UpdateCommand({
        TableName: process.env.JOBS_TABLE,
        Key: { jobId },
        UpdateExpression: "SET #status = :finalizing",
        ConditionExpression:
          "#status = :processing AND completedRows = totalRows",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":finalizing": "FINALIZING",
          ":processing": "PROCESSING",
        },
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException")
      return;
    throw error;
  }

  try {
    const invalidRows: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: process.env.ERRORS_TABLE,
          KeyConditionExpression: "jobId = :jobId",
          ExpressionAttributeValues: { ":jobId": jobId },
          ExclusiveStartKey: lastKey,
        }),
      );
      invalidRows.push(...(page.Items ?? []));
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    let reportUrl = "";
    if (invalidRows.length) {
      const reportColumns = [
        ["rowNumber", "rowNumber"],
        ["name", "name"],
        ["email", "email"],
        ["contact number", "contactNumber"],
        ["address", "address"],
        ["errors", "errors"],
      ];
      const quote = (value: unknown) =>
        `"${String(value ?? "").replace(/"/g, '""')}"`;
      const csv = [
        reportColumns.map(([header]) => header).join(","),
        ...invalidRows.map((row) =>
          reportColumns.map(([, key]) => quote(row[key])).join(","),
        ),
      ].join("\n");
      const reportKey = `reports/${jobId}-errors.csv`;
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.REPORTS_BUCKET,
          Key: reportKey,
          Body: csv,
          ContentType: "text/csv",
        }),
      );
      reportUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.REPORTS_BUCKET,
          Key: reportKey,
        }),
        { expiresIn: 7 * 24 * 60 * 60 },
      );
    }

    const validCount = Number(job.Item.validRows ?? 0);
    const invalidCount = Number(job.Item.invalidRows ?? 0);
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [process.env.NOTIFICATION_EMAIL!] },
        Content: {
          Simple: {
            Subject: { Data: `Excel import ${jobId} completed` },
            Body: {
              Text: {
                Data: `Import completed. Valid rows: ${validCount}. Invalid rows: ${invalidCount}.${reportUrl ? `\nError report (expires in 7 days): ${reportUrl}` : ""}`,
              },
            },
          },
        },
      }),
    );
    await db.send(
      new UpdateCommand({
        TableName: process.env.JOBS_TABLE,
        Key: { jobId },
        UpdateExpression: "SET #status = :complete, finishedAt = :finishedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":complete": "COMPLETE",
          ":finishedAt": new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    await db.send(
      new UpdateCommand({
        TableName: process.env.JOBS_TABLE,
        Key: { jobId },
        UpdateExpression: "SET #status = :processing",
        ConditionExpression: "#status = :finalizing",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":processing": "PROCESSING",
          ":finalizing": "FINALIZING",
        },
      }),
    );
    throw error;
  }
}
