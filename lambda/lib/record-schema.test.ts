import { describe, expect, test } from "@jest/globals";
import { mapCsvRow, recordSchema } from "./record-schema";

describe("recordSchema", () => {
  test("maps the CSV contact number header and trims valid values", () => {
    const result = recordSchema.safeParse(
      mapCsvRow({
        Name: " Ada Lovelace ",
        Email: " ada@example.com ",
        "Contact Number": "+1 (415) 555-2671",
        Address: " 1 Main Street ",
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "Ada Lovelace",
        email: "ada@example.com",
        contactNumber: "+1 (415) 555-2671",
        address: "1 Main Street",
      });
    }
  });

  test.each([
    {
      name: "",
      email: "ada@example.com",
      contactNumber: "+14155552671",
      address: "1 Main St",
    },
    {
      name: "Ada",
      email: "invalid",
      contactNumber: "+14155552671",
      address: "1 Main St",
    },
    {
      name: "Ada",
      email: "ada@example.com",
      contactNumber: "415-55",
      address: "1 Main St",
    },
    {
      name: "Ada",
      email: "ada@example.com",
      contactNumber: "+14155552671",
      address: " ",
    },
  ])("rejects records that fail a required field rule", (record) => {
    expect(recordSchema.safeParse(record).success).toBe(false);
  });
});
