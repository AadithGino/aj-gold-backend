const fs = require("fs");
const path = require("path");
const {
  FCM_ENABLED,
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  GOOGLE_APPLICATION_CREDENTIALS,
} = require("../config/env");
const { listTokensForUser, removeDeviceTokens } = require("./device.service");
const { log } = require("../utils/logger");

const PUSH_TOPICS = new Set(["PAYMENT_RECEIVED"]);

let firebaseApp = null;
let firebaseAdmin = null;
let initAttempted = false;

const loadFirebaseAdmin = () => {
  if (firebaseAdmin) return firebaseAdmin;
  try {
    // Lazy load so the API can start when FCM is disabled or deps are not installed yet.
    firebaseAdmin = require("firebase-admin");
    return firebaseAdmin;
  } catch (error) {
    log("error", "push.firebase.module_missing", {
      message: String(error.message || "firebase-admin is not installed."),
    });
    return null;
  }
};

const normalizePrivateKey = (value) => String(value || "").replace(/\\n/g, "\n");

const resolveCredentialsPath = (credentialsPath) => {
  const trimmed = String(credentialsPath || "").trim();
  if (!trimmed) return "";
  if (path.isAbsolute(trimmed)) return trimmed;
  const projectRoot = path.join(__dirname, "../..");
  return path.resolve(projectRoot, trimmed);
};

const getFirebaseApp = () => {
  if (!FCM_ENABLED) return null;
  if (firebaseApp) return firebaseApp;
  if (initAttempted) return null;
  initAttempted = true;

  const admin = loadFirebaseAdmin();
  if (!admin) return null;

  try {
    const credentialsPath = resolveCredentialsPath(GOOGLE_APPLICATION_CREDENTIALS);
    if (credentialsPath) {
      const raw = fs.readFileSync(credentialsPath, "utf8");
      const serviceAccount = JSON.parse(raw);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      return firebaseApp;
    }

    if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: normalizePrivateKey(FIREBASE_PRIVATE_KEY),
        }),
      });
      return firebaseApp;
    }

    log("warn", "push.firebase.not_configured", {
      message: "FCM is enabled but Firebase credentials are missing.",
    });
    return null;
  } catch (error) {
    log("error", "push.firebase.init_failed", {
      message: String(error.message || "Firebase init failed"),
      credentialsPath: resolveCredentialsPath(GOOGLE_APPLICATION_CREDENTIALS) || null,
    });
    return null;
  }
};

const stringifyData = (data = {}) =>
  Object.entries(data).reduce((acc, [key, value]) => {
    if (value === undefined || value === null) return acc;
    acc[key] = typeof value === "string" ? value : JSON.stringify(value);
    return acc;
  }, {});

const isInvalidTokenError = (error) => {
  const code = error?.code || error?.errorInfo?.code || "";
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
};

const sendPushToUser = async (userId, { title, body, data = {} }) => {
  const app = getFirebaseApp();
  if (!app) return { sent: 0, failed: 0, skipped: true };

  const admin = loadFirebaseAdmin();
  if (!admin) return { sent: 0, failed: 0, skipped: true };

  const records = await listTokensForUser(userId);
  const tokens = records.map((record) => record.token).filter(Boolean);
  if (!tokens.length) return { sent: 0, failed: 0, skipped: false };

  const message = {
    notification: { title, body },
    data: stringifyData(data),
    android: {
      priority: "high",
      notification: {
        channelId: "payment_updates",
        priority: "high",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  };

  const response = await admin.messaging().sendEachForMulticast({
    ...message,
    tokens,
  });

  const invalidTokens = [];
  response.responses.forEach((item, index) => {
    if (!item.success && isInvalidTokenError(item.error)) {
      invalidTokens.push(tokens[index]);
    }
  });

  if (invalidTokens.length) {
    await removeDeviceTokens(invalidTokens);
  }

  return {
    sent: response.successCount,
    failed: response.failureCount,
    skipped: false,
    invalidTokensRemoved: invalidTokens.length,
  };
};

const deliverPushNotification = async (payload, topic) => {
  if (!FCM_ENABLED || !PUSH_TOPICS.has(topic)) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const { recipient, title, message, data, type } = payload;
  if (!recipient || !title || !message) {
    throw new Error("Invalid push notification payload.");
  }

  return sendPushToUser(recipient, {
    title,
    body: message,
    data: {
      ...(data || {}),
      type: type || topic,
    },
  });
};

module.exports = {
  deliverPushNotification,
  sendPushToUser,
  getFirebaseApp,
  PUSH_TOPICS,
};
