const express = require("express");
const multer = require("multer");
const Tesseract = require("tesseract.js");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

function extractTransactionIdFromText(inputText) {
  if (!inputText) return null;
  const text = String(inputText).replace(/\s+/g, " ").trim();

  const urlMatch = text.match(/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/i);
  if (urlMatch?.[1]) return urlMatch[1].toUpperCase();

  const amharicMatch = text.match(/ቁጥርዎ\s+([A-Z0-9]+)\s+ነዉ/i);
  if (amharicMatch?.[1]) return amharicMatch[1].toUpperCase();

  const labeledMatch = text.match(/(?:transaction|receipt|trx|tx)\s*(?:id|no|number)?\s*[:#-]?\s*([A-Z0-9]{8,20})/i);
  if (labeledMatch?.[1]) return labeledMatch[1].toUpperCase();

  const plainMatch = text.match(/\b([A-Z0-9]{10})\b/);
  if (plainMatch?.[1]) return plainMatch[1].toUpperCase();

  return null;
}

router.post("/ocr-screenshot", upload.single("screenshot"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: "Screenshot image is required.",
      });
    }

    if (!file.mimetype?.startsWith("image/")) {
      return res.status(400).json({
        success: false,
        error: "Only image files are allowed.",
      });
    }

    const ocrResult = await Tesseract.recognize(file.buffer, "eng");
    const ocrText = ocrResult?.data?.text || "";
    const transactionId = extractTransactionIdFromText(ocrText);

    if (!transactionId) {
      return res.status(422).json({
        success: false,
        error: "Could not extract transaction ID from screenshot.",
        ocrText,
      });
    }

    return res.json({
      success: true,
      transactionId,
      ocrText,
      message: "Transaction ID extracted from screenshot.",
    });
  } catch (error) {
    console.error("/api/ocr-screenshot error:", error);
    return res.status(500).json({
      success: false,
      error: "Server error while reading screenshot.",
    });
  }
});

module.exports = router;
