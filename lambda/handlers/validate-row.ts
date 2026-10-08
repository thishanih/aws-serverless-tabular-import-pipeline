import { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { finalizeJob } from "../lib/finalize-job";
import { recordSchema, RecordInput } from "../lib/record-schema";

interface RowMessage extends RecordInput {
  jobId: string;
  rowNumber: number;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const row = JSON.parse(record.body) as RowMessage;
      const parsed = recordSchema.safeParse(row);
      const errors = parsed.success
        ? []
        : parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
          );
      if (errors.length) {
        try {
          await db.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: process.env.ERRORS_TABLE,
                    Item: {
                      ...row,
                      errors,
                      createdAt: new Date().toISOString(),
                    },
                    ConditionExpression: "attribute_not_exists(jobId)",
                  },
                },
                {
                  Update: {
                    TableName: process.env.JOBS_TABLE,
                    Key: { jobId: row.jobId },
                    UpdateExpression:
                      "ADD completedRows :one, invalidRows :one",
                    ExpressionAttributeValues: { ":one": 1 },
                  },
                },
              ],
            }),
          );
        } catch (error) {
          if (
            (error as { name?: string }).name !== "TransactionCanceledException"
          )
            throw error;
          const existing = await db.send(
            new GetCommand({
              TableName: process.env.ERRORS_TABLE,
              Key: { jobId: row.jobId, rowNumber: row.rowNumber },
              ConsistentRead: true,
            }),
          );
          if (!existing.Item) throw error;
        }
        await finalizeJob(row.jobId);
      } else {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: process.env.RECORDS_QUEUE_URL,
            MessageBody: JSON.stringify({
              ...parsed.data,
              jobId: row.jobId,
              rowNumber: row.rowNumber,
            }),
          }),
        );
      }
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
