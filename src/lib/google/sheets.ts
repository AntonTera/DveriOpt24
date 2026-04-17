import { google } from "googleapis";

import { getServerEnv } from "@/lib/env";
import { SheetName, SheetRowPayload } from "@/lib/types";

function getSheetsClient() {
  const env = getServerEnv();
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive"
    ]
  });

  return {
    env,
    client: google.sheets({
      version: "v4",
      auth
    })
  };
}

function formatRow(sheetName: SheetName, row: SheetRowPayload): Array<string | number> {
  if (sheetName === "KP new") {
    return [row.date, row.time ?? "", row.kpiLabel, row.leadName, row.amount, row.link, row.dealId];
  }

  return [
    row.date,
    row.leadName,
    row.kpiLabel,
    row.amount,
    row.link,
    row.dealId,
    row.installDate ?? ""
  ];
}

function getRange(sheetName: SheetName, rowIndex: number) {
  return `${sheetName}!A${rowIndex}:G${rowIndex}`;
}

function parseRowIndex(updatedRange: string | null | undefined): number | null {
  if (!updatedRange) {
    return null;
  }

  const match = updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)/);
  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function getIdColumnIndex(sheetName: SheetName): number {
  return sheetName === "KP new" ? 6 : 5;
}

export async function appendSheetRow(sheetName: SheetName, row: SheetRowPayload): Promise<number | null> {
  const { env, client } = getSheetsClient();
  const response = await client.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${sheetName}!A:G`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [formatRow(sheetName, row)]
    }
  });

  return parseRowIndex(response.data.updates?.updatedRange);
}

export async function updateSheetRow(sheetName: SheetName, rowIndex: number, row: SheetRowPayload) {
  const { env, client } = getSheetsClient();
  await client.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: getRange(sheetName, rowIndex),
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [formatRow(sheetName, row)]
    }
  });
}

export async function findSheetRowByDealAndKpi(
  sheetName: SheetName,
  dealId: number,
  kpiLabel: string
): Promise<number | null> {
  const { env, client } = getSheetsClient();
  const response = await client.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${sheetName}!A:G`
  });

  const rows = response.data.values ?? [];
  const idColumn = getIdColumnIndex(sheetName);
  const kpiColumn = 2;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (Number(row[idColumn]) === dealId && row[kpiColumn] === kpiLabel) {
      return index + 1;
    }
  }

  return null;
}
