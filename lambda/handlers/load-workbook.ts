import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import ExcelJS from "exceljs";
import { Readable } from "stream";

interface LoadInput {
  bucket: string;
  key: string;
  jobId: string;
}

const s3 = new S3Client({});
const sqs = new SQSClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(
  input: LoadInput,
): Promise<{ jobId: string; totalRows: number }> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
  );
  if (!response.Body) throw new Error("Uploaded workbook has no content");
  const content = Buffer.from(await response.Body.transformToByteArray());
  const workbook = new ExcelJS.Workbook();
  if (input.key.toLowerCase().endsWith(".csv")) {
    await workbook.csv.read(Readable.from(content));
  } else {
    await workbook.xlsx.load(content as unknown as Buffer);
  }
  const firstSheet = workbook.worksheets[0];
  if (!firstSheet) throw new Error("Workbook has no worksheets");

  const headers = firstSheet.getRow(1).values as Array<
    ExcelJS.CellValue | undefined
  >;
  const headerIndexes = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header !== undefined)
      headerIndexes.set(String(header).trim().toLowerCase(), index);
  });
  const messages =
    firstSheet.getRows(2, Math.max(0, firstSheet.rowCount - 1))?.map((row) => {
      const getValue = (column: string) => {
        const index = headerIndexes.get(column);
        return String(
          index === undefined ? "" : row.getCell(index).text,
        ).trim();
      };
      return {
        Id: String(row.number),
        MessageBody: JSON.stringify({
          jobId: input.jobId,
          rowNumber: row.number,
          email: getValue("email"),
          name: getValue("name"),
          contactNumber: getValue("contact number"),
          address: getValue("address"),
        }),
      };
    }) ?? [];
  if (messages.length === 0) throw new Error("Workbook has no data rows");

  await db.send(
    new PutCommand({
      TableName: process.env.JOBS_TABLE,
      Item: {
        jobId: input.jobId,
        status: "PROCESSING",
        totalRows: messages.length,
        completedRows: 0,
        validRows: 0,
        invalidRows: 0,
        sourceKey: input.key,
        createdAt: new Date().toISOString(),
      },
    }),
  );

  for (let offset = 0; offset < messages.length; offset += 10) {
    const batch = messages.slice(offset, offset + 10);
    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: process.env.VALIDATION_QUEUE_URL,
        Entries: batch,
      }),
    );
    if (result.Failed?.length)
      throw new Error(`Failed to enqueue ${result.Failed.length} row(s)`);
  }
  return { jobId: input.jobId, totalRows: messages.length };
}
