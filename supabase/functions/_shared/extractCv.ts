// Scan and extract text from an uploaded CV file, for score-application/index.ts.
//
// PDF text extraction uses unpdf, built for exactly this (edge/serverless
// runtimes, Deno included). DOCX support is deliberately SMALLER than a first
// draft attempted: officeparser's Deno compatibility could not be confirmed,
// and this file has no way to be executed before it ships (no Deno runtime in
// the sandbox that built it) -- so rather than ship an unverified import that
// could fail at the Deno import-resolution stage and take the whole function
// down with it, a .docx gets its safety checks (magic bytes, macro scan) and
// no text extraction. An admin can still open the stored file directly; the
// scorer works from the applicant's typed answers and any PDF/image instead.
//
// The macro check does NOT use a zip library. DOCX entry names sit as plain
// ASCII bytes in each entry's local file header, so a raw case-insensitive
// byte search for "vbaproject.bin" across the file is dependency-free and
// answers the one question that matters -- is a macro payload present at all
// -- without trusting an unverified import to parse the archive correctly.

export interface ExtractResult {
  text: string;
  flagged: boolean;
  note: string;
}

const MAGIC = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  zip: [0x50, 0x4b, 0x03, 0x04], // PK.. -- docx is a zip
};

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function matchesMagic(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

function validateMagicBytes(bytes: Uint8Array, mime: string): boolean {
  if (mime === "application/pdf") return matchesMagic(bytes, MAGIC.pdf);
  if (mime === "image/jpeg") return matchesMagic(bytes, MAGIC.jpeg);
  if (mime === "image/png") return matchesMagic(bytes, MAGIC.png);
  if (mime === DOCX_MIME) return matchesMagic(bytes, MAGIC.zip);
  return false;
}

// A dependency-free, case-insensitive byte search for one ASCII needle in a
// (possibly large) haystack. Zip entry names are stored uncompressed in each
// local file header, so this finds "vbaProject.bin" (any case) wherever it
// appears in the file, without parsing the archive structure at all.
function containsAsciiCaseInsensitive(haystack: Uint8Array, needle: string): boolean {
  const pat = Array.from(needle.toLowerCase(), (c) => c.charCodeAt(0));
  const lower = (b: number) => (b >= 65 && b <= 90 ? b + 32 : b); // 'A'-'Z' -> 'a'-'z'
  outer: for (let i = 0; i <= haystack.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) {
      if (lower(haystack[i + j]) !== pat[j]) continue outer;
    }
    return true;
  }
  return false;
}

// Zero-width and other invisible/control characters that can hide instructions
// from a human reviewer while an AI (or a careless one) still reads them.
const INVISIBLE_CHARS = /\u200B|\u200C|\u200D|\uFEFF|[\p{Cf}\p{Cc}]/gu;

function cleanText(text: string): string {
  return text.replace(INVISIBLE_CHARS, "");
}

// Phrases aimed at a downstream AI scorer, not at a human reader. Found means
// flagged, never silently stripped -- an admin has to be able to see exactly
// what was submitted.
const INJECTION_PHRASES = [
  "ignore previous instructions",
  "ignore the rubric",
  "ignore all previous",
  "you are now",
  "system:",
  "disregard the above",
];

function findInjectionPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return INJECTION_PHRASES.filter((p) => lower.includes(p));
}

export async function extractAndScanCv(
  fileBytes: Uint8Array,
  mime: string,
): Promise<ExtractResult> {
  if (!validateMagicBytes(fileBytes, mime)) {
    return {
      text: "",
      flagged: true,
      note: "file type does not match its declared type",
    };
  }

  if (mime === "image/jpeg" || mime === "image/png") {
    return { text: "", flagged: false, note: "" };
  }

  if (mime === DOCX_MIME) {
    if (containsAsciiCaseInsensitive(fileBytes, "vbaProject.bin")) {
      return {
        text: "",
        flagged: true,
        note: "file contains a macro and was rejected",
      };
    }
    // Safe, but no text extraction yet -- see the file header comment.
    return { text: "", flagged: false, note: "" };
  }

  if (mime === "application/pdf") {
    try {
      const { extractText, getDocumentProxy } = await import("npm:unpdf@1.4.0");
      const pdf = await getDocumentProxy(fileBytes);
      const { text } = await extractText(pdf, { mergePages: true });
      const cleaned = cleanText(text || "").slice(0, 20000);
      const injected = findInjectionPhrases(cleaned);
      return {
        text: cleaned,
        flagged: injected.length > 0,
        note: injected.length > 0 ? `possible prompt injection: ${injected.join(", ")}` : "",
      };
    } catch (error) {
      return {
        text: "",
        flagged: true,
        note: `PDF extraction failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  return { text: "", flagged: true, note: `unsupported file type: ${mime}` };
}
