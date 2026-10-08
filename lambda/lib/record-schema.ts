import { z } from "zod";

const contactNumberSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9().\s-]+$/, "Contact number has an unsupported character")
  .refine((value) => {
    const digitCount = value.replace(/\D/g, "").length;
    return digitCount >= 7 && digitCount <= 15;
  }, "Contact number must contain 7 to 15 digits");

export const recordSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().pipe(z.email("Invalid email")),
  contactNumber: contactNumberSchema,
  address: z.string().trim().min(1, "Address is required"),
});

export function mapCsvRow(row: Record<string, unknown>) {
  const headers = new Map(
    Object.entries(row).map(([header, value]) => [
      header.trim().toLowerCase(),
      value,
    ]),
  );
  return {
    name: headers.get("name"),
    email: headers.get("email"),
    contactNumber: headers.get("contact number"),
    address: headers.get("address"),
  };
}

export type RecordInput = z.infer<typeof recordSchema>;
