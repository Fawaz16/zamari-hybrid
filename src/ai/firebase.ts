/**
 * Firebase bootstrap for Zamari.
 *
 * Order matters:
 *   1. initializeApp
 *   2. App Check (debug token flag must be set BEFORE initializeAppCheck)
 *   3. getAI — so every Firebase AI Logic request carries an App Check token.
 *
 * All model access goes through `getHybridModel()`, which returns cached
 * `firebase/ai` GenerativeModels configured for hybrid inference.
 */
import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  ResponseModality,
  type AI,
  type GenerativeModel,
  type LanguageModelExpected,
} from 'firebase/ai';

declare global {
  // Read by the App Check SDK. `true` = generate a token and log it; string = use that token.
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}

const env = import.meta.env;

const firebaseConfig: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
};

export const CLOUD_MODEL_FAST: string = env.VITE_CLOUD_MODEL_FAST || 'gemini-3.5-flash-lite';
export const CLOUD_MODEL_COMPLEX: string = env.VITE_CLOUD_MODEL_COMPLEX || 'gemini-3.6-flash';
/** Optional extra Gemini model tried when both of the above are busy or rate-limited. */
export const CLOUD_MODEL_BACKUP: string = env.VITE_CLOUD_MODEL_BACKUP || '';
/** Image generation is cloud-only and needs the Firebase Blaze plan (no free-tier quota). */
export const CLOUD_MODEL_IMAGE: string = env.VITE_CLOUD_MODEL_IMAGE || 'gemini-3.1-flash-image-preview';
export const IMAGE_DAILY_LIMIT: number = Math.max(0, Number(env.VITE_IMAGE_DAILY_LIMIT ?? 3) || 0);

/** True when the minimum Firebase config is present. The UI shows a setup banner otherwise. */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
);

// ---------------------------------------------------------------------------
// App + App Check
// ---------------------------------------------------------------------------

function enableAppCheckDebugMode(): void {
  const token = (env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined)?.trim();
  if (env.DEV) {
    // Local dev: reuse a registered token if provided, else let the SDK mint one
    // and print it to the console for registration in the Firebase console.
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = token || true;
  } else if (token) {
    // Hosted test builds only. A debug token in a public build bypasses App Check.
    console.warn('[Zamari] App Check debug token is active in a production build. Use for testing only.');
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
  }
}

function bootstrap(): { app: FirebaseApp; ai: AI } | null {
  if (!isFirebaseConfigured) return null;

  const app = initializeApp(firebaseConfig);

  enableAppCheckDebugMode();
  const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined;
  if (siteKey || self.FIREBASE_APPCHECK_DEBUG_TOKEN) {
    initializeAppCheck(app, {
      // In debug mode the SDK swaps in the debug provider; the site key is unused.
      provider: new ReCaptchaEnterpriseProvider(siteKey || 'debug-mode'),
      isTokenAutoRefreshEnabled: true,
    });
  } else {
    console.warn(
      '[Zamari] App Check not initialised: set VITE_RECAPTCHA_ENTERPRISE_SITE_KEY. ' +
        'Requests will fail if App Check enforcement is on for Firebase AI Logic.',
    );
  }

  // Gemini Developer API backend. Swap for `new VertexAIBackend()` if preferred.
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  return { app, ai };
}

const firebase = bootstrap();

// ---------------------------------------------------------------------------
// Hybrid models
// ---------------------------------------------------------------------------

/** Gemini Nano's Prompt API needs explicit input/output languages to pick the right model. */
const EN_TEXT: LanguageModelExpected[] = [{ type: 'text', languages: ['en'] }];

const modelCache = new Map<string, GenerativeModel>();

export interface HybridModelOptions {
  /** Cloud model used when inference runs (or falls back) in the cloud. */
  cloudModel?: string;
  temperature?: number;
  /** JSON Schema that constrains Gemini Nano's output (Prompt API `responseConstraint`). */
  onDeviceJsonSchema?: { name: string; schema: object };
  /** Ask the cloud model to return images as well as text. */
  imageOutput?: boolean;
  /**
   * Give the cloud model Google Search grounding so it can answer with live,
   * up-to-date information. Ignored on-device (Nano has no tools).
   */
  webSearch?: boolean;
}

/**
 * Returns a cached hybrid GenerativeModel for the given inference mode.
 *
 * Note: Gemini Nano ignores `systemInstruction` and every on-device call is a
 * fresh session, so callers must put all instructions + context in the prompt.
 */
export function getHybridModel(
  mode: InferenceMode,
  { cloudModel = CLOUD_MODEL_FAST, temperature, onDeviceJsonSchema, imageOutput, webSearch }: HybridModelOptions = {},
): GenerativeModel {
  if (!firebase) {
    throw new Error('Firebase is not configured. Copy .env.example to .env.local and fill it in.');
  }
  const key = `${mode}|${cloudModel}|${temperature ?? ''}|${onDeviceJsonSchema?.name ?? ''}|${imageOutput ? 'img' : ''}|${webSearch ? 'search' : ''}`;
  let model = modelCache.get(key);
  if (!model) {
    model = getGenerativeModel(firebase.ai, {
      mode,
      inCloudParams: {
        model: cloudModel,
        generationConfig: {
          ...(temperature !== undefined && { temperature }),
          ...(imageOutput && { responseModalities: [ResponseModality.TEXT, ResponseModality.IMAGE] }),
        },
        ...(webSearch && { tools: [{ googleSearch: {} }] }),
      },
      onDeviceParams: {
        createOptions: { expectedInputs: EN_TEXT, expectedOutputs: EN_TEXT },
        ...(onDeviceJsonSchema && {
          promptOptions: { responseConstraint: onDeviceJsonSchema.schema },
        }),
      },
    });
    modelCache.set(key, model);
  }
  return model;
}

// ---------------------------------------------------------------------------
// Gemini Nano availability
// ---------------------------------------------------------------------------

export type NanoStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface ChromeLanguageModel {
  availability(options?: object): Promise<NanoStatus>;
}

/** Reads Chrome's Prompt API availability without creating a session. */
export async function getNanoStatus(): Promise<NanoStatus> {
  const lm = (globalThis as { LanguageModel?: ChromeLanguageModel }).LanguageModel;
  if (!lm) return 'unavailable';
  try {
    return await lm.availability({ expectedInputs: EN_TEXT, expectedOutputs: EN_TEXT });
  } catch {
    return 'unavailable';
  }
}

/**
 * Downloads / warms up Gemini Nano. MUST be called from a user gesture
 * (click/keypress) — Chrome rejects model downloads without user activation.
 */
export async function prepareNano(onProgress?: (fraction: number) => void): Promise<void> {
  await getHybridModel(InferenceMode.PREFER_ON_DEVICE).initializeDeviceModel(onProgress);
}
