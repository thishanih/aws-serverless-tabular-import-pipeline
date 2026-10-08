import { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { finalizeJob } from "../lib/finalize-job";

interface RowMessage {
  jobId: string;
  rowNumber: number;
  email: string;
  name: string;
  contactNumber: string;
  address: string;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const row = JSON.parse(record.body) as RowMessage;
      try {
        await db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: process.env.RECORDS_TABLE,
                  Item: { ...row, createdAt: new Date().toISOString() },
                  ConditionExpression: "attribute_not_exists(jobId)",
                },
              },
              {
                Update: {
                  TableName: process.env.JOBS_TABLE,
                  Key: { jobId: row.jobId },
                  UpdateExpression: "ADD completedRows :one, validRows :one",
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
            TableName: process.env.RECORDS_TABLE,
            Key: { jobId: row.jobId, rowNumber: row.rowNumber },
            ConsistentRead: true,
          }),
        );
        if (!existing.Item) throw error;
      }
      await finalizeJob(row.jobId);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
