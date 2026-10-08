import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mapCsvRow, recordSchema } from "../lib/record-schema";

interface CsvItem {
  jobId: string;
  rowIndex: number;
  row: Record<string, unknown>;
}

interface CsvBatchInput {
  Items: CsvItem[];
}

interface InvalidRow {
  rowNumber: number;
  name: string;
  email: string;
  contactNumber: string;
  address: string;
  errors: string;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const chunkShardCount = 64;
const dynamoBatchSize = 25;

const stringValue = (value: unknown): string =>
  typeof value === "string" ? value : "";

const quoteCsv = (value: unknown): string =>
  `"${String(value ?? "").replace(/"/g, '""')}"`;

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function writeRecords(
  tableName: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  for (let offset = 0; offset < records.length; offset += dynamoBatchSize) {
    let pending = records
      .slice(offset, offset + dynamoBatchSize)
      .map((Item) => ({ PutRequest: { Item } }));

    for (let attempt = 0; pending.length > 0 && attempt < 8; attempt += 1) {
      const result = await db.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: pending },
        }),
      );
      pending =
        (result.UnprocessedItems?.[tableName] as typeof pending | undefined) ??
        [];
      if (pending.length > 0)
        await wait(Math.min(1000, 50 * 2 ** attempt) + Math.random() * 50);
    }

    if (pending.length > 0)
      throw new Error("DynamoDB left records unprocessed after retries");
  }
}

export async function handler(
  input: CsvBatchInput,
): Promise<{
  chunkId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
}> {
  if (input.Items.length === 0) throw new Error("CSV batch is empty");

  const firstItem = input.Items[0];
  const lastItem = input.Items[input.Items.length - 1];
  const jobId = firstItem.jobId;
  if (input.Items.some((item) => item.jobId !== jobId))
    throw new Error("CSV batch contains more than one job ID");

  const firstRowNumber = firstItem.rowIndex + 2;
  const lastRowNumber = lastItem.rowIndex + 2;
  const chunkId = `${firstRowNumber}-${lastRowNumber}`;
  const jobShard = `${jobId}#${firstItem.rowIndex % chunkShardCount}`;
  const summariesTable = process.env.CHUNK_SUMMARIES_TABLE;
  const recordsTable = process.env.RECORDS_TABLE;
  const reportsBucket = process.env.REPORTS_BUCKET;
  if (!summariesTable || !recordsTable || !reportsBucket)
    throw new Error("CSV batch storage is not configured");

  const existing = await db.send(
    new GetCommand({
      TableName: summariesTable,
      Key: { jobShard, chunkId },
      ConsistentRead: true,
    }),
  );
  if (existing.Item) {
    return {
      chunkId,
      totalRows: Number(existing.Item.totalRows),
      validRows: Number(existing.Item.validRows),
      invalidRows: Number(existing.Item.invalidRows),
    };
  }

  const validRecords: Array<Record<string, unknown>> = [];
  const invalidRows: InvalidRow[] = [];
  for (const item of input.Items) {
    const csvRow = mapCsvRow(item.row ?? {});
    const parsed = recordSchema.safeParse(csvRow);

    if (!parsed.success) {
      invalidRows.push({
        rowNumber: item.rowIndex + 2,
        name: stringValue(csvRow.name),
        email: stringValue(csvRow.email),
        contactNumber: stringValue(csvRow.contactNumber),
        address: stringValue(csvRow.address),
        errors: parsed.error.issues
          .map(
            (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
          )
          .join("; "),
      });
      continue;
    }

    validRecords.push({
      jobId,
      rowNumber: item.rowIndex + 2,
      ...parsed.data,
    });
  }

  let errorObjectKey: string | undefined;
  if (invalidRows.length > 0) {
    errorObjectKey = `reports/${jobId}/errors/${chunkId}.csv`;
    const csv = [
      ["rowNumber", "name", "email", "contact number", "address", "errors"]
        .map(quoteCsv)
        .join(","),
      ...invalidRows.map((row) =>
        [
          row.rowNumber,
          row.name,
          row.email,
          row.contactNumber,
          row.address,
          row.errors,
        ]
          .map(quoteCsv)
          .join(","),
      ),
    ].join("\n");
    await s3.send(
      new PutObjectCommand({
        Bucket: reportsBucket,
        Key: errorObjectKey,
        Body: csv,
        ContentType: "text/csv",
      }),
    );
  }

  await writeRecords(recordsTable, validRecords);

  const summary = {
    jobShard,
    chunkId,
    totalRows: input.Items.length,
    validRows: validRecords.length,
    invalidRows: invalidRows.length,
    ...(errorObjectKey ? { errorObjectKey } : {}),
  };
  try {
    await db.send(
      new PutCommand({
        TableName: summariesTable,
        Item: summary,
        ConditionExpression:
          "attribute_not_exists(jobShard) AND attribute_not_exists(chunkId)",
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException")
      throw error;
    const savedSummary = await db.send(
      new GetCommand({
        TableName: summariesTable,
        Key: { jobShard, chunkId },
        ConsistentRead: true,
      }),
    );
    if (!savedSummary.Item) throw error;
    return {
      chunkId,
      totalRows: Number(savedSummary.Item.totalRows),
      validRows: Number(savedSummary.Item.validRows),
      invalidRows: Number(savedSummary.Item.invalidRows),
    };
  }

  return {
    chunkId,
    totalRows: summary.totalRows,
    validRows: summary.validRows,
    invalidRows: summary.invalidRows,
  };
}
