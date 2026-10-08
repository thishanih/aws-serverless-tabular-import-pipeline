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

interface FinalizeInput {
  jobId: string;
}

interface ChunkSummary {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errorObjectKey?: string;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ses = new SESv2Client({});
const chunkShardCount = 64;

export async function handler(input: FinalizeInput): Promise<void> {
  const jobsTable = process.env.JOBS_TABLE;
  const summariesTable = process.env.CHUNK_SUMMARIES_TABLE;
  const reportsBucket = process.env.REPORTS_BUCKET;
  const notificationEmail = process.env.NOTIFICATION_EMAIL;
  const senderEmail = process.env.SES_FROM_EMAIL;
  if (
    !jobsTable ||
    !summariesTable ||
    !reportsBucket ||
    !notificationEmail ||
    !senderEmail
  )
    throw new Error("CSV finalization is not configured");

  const job = await db.send(
    new GetCommand({
      TableName: jobsTable,
      Key: { jobId: input.jobId },
      ConsistentRead: true,
    }),
  );
  if (!job.Item) throw new Error(`Job ${input.jobId} does not exist`);
  if (job.Item.status === "COMPLETE") return;

  await db.send(
    new UpdateCommand({
      TableName: jobsTable,
      Key: { jobId: input.jobId },
      UpdateExpression: "SET #status = :finalizing",
      ConditionExpression: "#status = :processing OR #status = :finalizing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":processing": "PROCESSING",
        ":finalizing": "FINALIZING",
      },
    }),
  );

  try {
    const shardResults = await Promise.all(
      Array.from({ length: chunkShardCount }, async (_, shard) => {
        const summaries: ChunkSummary[] = [];
        let lastKey: Record<string, unknown> | undefined;
        do {
          const page = await db.send(
            new QueryCommand({
              TableName: summariesTable,
              KeyConditionExpression: "jobShard = :jobShard",
              ExpressionAttributeValues: {
                ":jobShard": `${input.jobId}#${shard}`,
              },
              ExclusiveStartKey: lastKey,
            }),
          );
          summaries.push(...((page.Items ?? []) as ChunkSummary[]));
          lastKey = page.LastEvaluatedKey;
        } while (lastKey);
        return summaries;
      }),
    );
    const summaries = shardResults.flat();
    const totalRows = summaries.reduce((sum, row) => sum + row.totalRows, 0);
    if (totalRows === 0) throw new Error("CSV contains no data rows");
    const validRows = summaries.reduce((sum, row) => sum + row.validRows, 0);
    const invalidRows = summaries.reduce(
      (sum, row) => sum + row.invalidRows,
      0,
    );
    const errorObjectKeys = summaries.flatMap((row) =>
      row.errorObjectKey ? [row.errorObjectKey] : [],
    );

    let reportUrl = "";
    if (errorObjectKeys.length > 0) {
      const manifestKey = `reports/${input.jobId}/errors/manifest.json`;
      await s3.send(
        new PutObjectCommand({
          Bucket: reportsBucket,
          Key: manifestKey,
          Body: JSON.stringify({ jobId: input.jobId, errorObjectKeys }),
          ContentType: "application/json",
        }),
      );
      reportUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: reportsBucket, Key: manifestKey }),
        { expiresIn: 7 * 24 * 60 * 60 },
      );
    }

    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: senderEmail,
        Destination: { ToAddresses: [notificationEmail] },
        Content: {
          Simple: {
            Subject: { Data: `CSV import ${input.jobId} completed` },
            Body: {
              Text: {
                Data: `Import completed. Total rows: ${totalRows}. Valid rows: ${validRows}. Invalid rows: ${invalidRows}.${reportUrl ? `\nError CSV manifest (expires in 7 days): ${reportUrl}` : ""}`,
              },
            },
          },
        },
      }),
    );
    await db.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId: input.jobId },
        UpdateExpression:
          "SET #status = :complete, totalRows = :totalRows, completedRows = :totalRows, validRows = :validRows, invalidRows = :invalidRows, finishedAt = :finishedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":complete": "COMPLETE",
          ":totalRows": totalRows,
          ":validRows": validRows,
          ":invalidRows": invalidRows,
          ":finishedAt": new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    await db.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId: input.jobId },
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
