/**
 * Client configuration.
 *
 * The publishable key is meant to be public: every table is protected by
 * row-level security, so it grants nothing on its own. The Gemini key is NOT
 * here and never will be: AI calls go through edge functions, which is the
 * whole reason the app has a server side at all.
 */

/**
 * Defaults point at the reference deployment. To run Markwise against your own
 * Supabase project without editing a tracked file, define the global before the
 * module loads, e.g. in a `config.local.js` that .gitignore already covers:
 *
 *   <script>window.MARKWISE_CONFIG = { url: "https://xxx.supabase.co", key: "sb_publishable_..." }</script>
 */
const OVERRIDE = (typeof window !== "undefined" && window.MARKWISE_CONFIG) || {};

export const SUPABASE_URL = OVERRIDE.url || "https://yfzlypcxsmlakpxkrtbu.supabase.co";
export const SUPABASE_KEY = OVERRIDE.key || "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export const APP_NAME = "Markwise";
export const APP_TAGLINE = "The Edexcel International GCSE assistant that has actually read the papers.";

export const STORAGE = {
  theme: "markwise-theme",
  prefs: "markwise-prefs-v1",
  auth: "markwise-auth",
};

/** Where the work came from. School and tuition, plus your own revision. */
export const SOURCES = [
  { id: "school", label: "School" },
  { id: "tuition", label: "Tuition" },
  { id: "self", label: "My own" },
];

/**
 * Blue pen for your own homework, red pen for anything an examiner sees,
 * green for revision you set yourself. Tuition has no assessments, which the
 * add-task form reflects.
 */
export const TASK_TYPES = [
  { id: "homework", label: "Homework" },
  { id: "assessment", label: "Assessment" },
  { id: "revision", label: "Revision" },
];

/** 0 low · 1 normal · 2 high. Matches tasks.priority. */
export const PRIORITIES = [
  { id: 0, label: "Low" },
  { id: 1, label: "Normal" },
  { id: 2, label: "High" },
];

/** Offered as chips on the task form; any whole number of minutes is valid. */
export const ESTIMATES = [15, 30, 45, 60, 90, 120];

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
