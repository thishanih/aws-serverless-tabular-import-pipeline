import { randomUUID } from "crypto";
import { S3Event } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const stepFunctions = new SFNClient({});

export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    await stepFunctions.send(
      new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        name: randomUUID(),
        input: JSON.stringify({ bucket, key, jobId: randomUUID() }),
      }),
    );
  }
}