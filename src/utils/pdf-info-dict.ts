/**
 * Typed wrappers around pdf-lib's Info Dict for custom metadata fields.
 *
 * pdf-lib doesn't expose getInfoDict() in its TypeScript types,
 * but it exists at runtime. These helpers centralize the `as any` cast.
 */

import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';

/**
 * Set a custom field in the PDF Info Dict.
 * No-op if value is falsy.
 */
export function setInfoDictField(pdfDoc: PDFDocument, key: string, value: string): void {
  if (!value) return;
  const infoDict = (pdfDoc as any).getInfoDict();
  infoDict.set(PDFName.of(key), PDFHexString.fromText(value));
}

/**
 * Set multiple custom fields in the PDF Info Dict.
 * Skips entries with falsy values.
 */
export function setInfoDictFields(pdfDoc: PDFDocument, fields: Record<string, string | null | undefined>): void {
  const infoDict = (pdfDoc as any).getInfoDict();
  for (const [key, value] of Object.entries(fields)) {
    if (value) {
      infoDict.set(PDFName.of(key), PDFHexString.fromText(value));
    }
  }
}

/**
 * Read a custom field from the PDF Info Dict.
 * Returns undefined if the field doesn't exist or parsing fails.
 */
export function readInfoDictField(pdfDoc: PDFDocument, key: string): string | undefined {
  try {
    const infoDict = (pdfDoc as any).getInfoDict();
    const value = infoDict.get(PDFName.of(key));
    if (!value) return undefined;
    return value.decodeText?.() || value.toString();
  } catch {
    return undefined;
  }
}
