const express = require("express");
const admin = require("firebase-admin");
const db = require("../config/firebase");
const { redis } = require("../config/redis");
const { verifyPayment } = require("./receiptService");

const router = express.Router();

function extractTransactionId(serviceResponse) {
  const sources = [
    serviceResponse,
    serviceResponse?.data,
    serviceResponse?.result,
    serviceResponse?.receipt,
  ];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    const candidate = source.transactionId
      || source.transaction_id
      || source.txId
      || source.tx_id
      || source.trxId
      || source.trx_id
      || source.reference
      || source.receiptId;

    if (candidate && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }

  return null;
}

function extractReceiptCode(input) {
  if (!input) return null;
  const normalizedInput = String(input).trim();

  const urlMatch = normalizedInput.match(/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  const amharicMatch = normalizedInput.match(/ቁጥርዎ\s+([A-Z0-9]+)\s+ነዉ/);
  if (amharicMatch) return amharicMatch[1];

  if (/^[A-Z0-9]{10}$/.test(normalizedInput)) return normalizedInput;

  return null;
}

function extractAmount(serviceResponse, expectedAmount) {
  const sources = [
    serviceResponse,
    serviceResponse?.data,
    serviceResponse?.result,
    serviceResponse?.receipt,
  ];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    const candidate = source.amount
      || source.paidAmount
      || source.verifiedAmount
      || source.totalAmount;
    const parsed = Number(candidate);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const fallback = Number(expectedAmount);
  if (Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }

  return null;
}

async function getTelegramIdFromRedisBySocket(socketId) {
  if (!socketId || !redis.isOpen) {
    return null;
  }

  const keys = await redis.keys("user:*:socket");

  for (const key of keys) {
    const savedSocket = await redis.get(key);
    if (savedSocket === socketId) {
      const match = key.match(/^user:(.+):socket$/);
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return null;
}

async function isTransactionUsed(transactionId) {
  const txDoc = await db.collection("transactions").doc(String(transactionId)).get();
  return txDoc.exists;
}

async function saveTransaction(transactionId, userId, amount) {
  const batch = db.batch();
  const txRef = db.collection("transactions").doc(String(transactionId));

  batch.set(txRef, {
    user_id: String(userId),
    amount,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  const statsRef = db.collection("stats").doc("deposits");
  batch.set(
    statsRef,
    {
      totalAmount: admin.firestore.FieldValue.increment(amount),
      count: admin.firestore.FieldValue.increment(1),
    },
    { merge: true }
  );

  await batch.commit();
}

async function addBalance(userId, amount) {
  const docRef = db.collection("users").doc(String(userId));
  await docRef.set(
    {
      balance: admin.firestore.FieldValue.increment(amount),
    },
    { merge: true }
  );
}

router.post("/check-receipt-demo", async (req, res) => {
  try {
    const { receiptTextOrLink, confirmedByUser, expectedAmount, socketId, userId } = req.body;

    if (!receiptTextOrLink || !String(receiptTextOrLink).trim()) {
      return res.status(400).json({
        success: false,
        error: "receiptTextOrLink is required.",
      });
    }

    if (!confirmedByUser) {
      return res.status(400).json({
        success: false,
        error: "Please confirm payment before submitting.",
      });
    }

    const serviceResponse = await verifyPayment(
      String(receiptTextOrLink).trim(),
      expectedAmount
    );

    const isValid = Boolean(serviceResponse?.valid);

    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: serviceResponse?.message || "Receipt verification failed.",
        serviceResponse,
      });
    }

    const transactionId = extractReceiptCode(receiptTextOrLink) || extractTransactionId(serviceResponse);
    if (!transactionId) {
      return res.status(400).json({
        success: false,
        error: "Receipt verified but transactionId was not found in the response.",
        serviceResponse,
      });
    }

    const alreadyUsed = await isTransactionUsed(transactionId);
    if (alreadyUsed) {
      return res.status(409).json({
        success: false,
        error: "This transaction has already been used.",
        transactionId,
      });
    }

    const telegramId = String(userId || await getTelegramIdFromRedisBySocket(socketId) || "").trim();
    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: "Unable to resolve Telegram user id from request/redis.",
      });
    }

    const amount = extractAmount(serviceResponse, expectedAmount);
    if (!amount) {
      return res.status(400).json({
        success: false,
        error: "Receipt verified but amount was not found.",
        transactionId,
      });
    }

    await saveTransaction(transactionId, telegramId, amount);
    await addBalance(telegramId, amount);

    return res.json({
      success: true,
      receiptStatus: "verified",
      message: serviceResponse?.message || "Receipt verified successfully.",
      serviceResponse,
      transactionId,
      creditedAmount: amount,
      telegramId,
      submittedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("/api/check-receipt-demo error:", error);
    return res.status(500).json({
      success: false,
      error: "Server error while checking receipt demo.",
    });
  }
});

module.exports = router;
