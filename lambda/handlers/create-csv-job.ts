import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

interface CsvJobInput {
  jobId: string;
  key: string;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(input: CsvJobInput): Promise<{ jobId: string }> {
  const jobsTable = process.env.JOBS_TABLE;
  if (!jobsTable) throw new Error("JOBS_TABLE is not configured");

  await db.send(
    new UpdateCommand({
      TableName: jobsTable,
      Key: { jobId: input.jobId },
      UpdateExpression:
        "SET #status = if_not_exists(#status, :processing), sourceKey = if_not_exists(sourceKey, :sourceKey), createdAt = if_not_exists(createdAt, :createdAt)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":processing": "PROCESSING",
        ":sourceKey": input.key,
        ":createdAt": new Date().toISOString(),
      },
    }),
  );

  return { jobId: input.jobId };
}
