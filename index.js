// @ts-check

import { Firestore } from "@google-cloud/firestore";
import { GoogleGenAI, Type } from "@google/genai";

/**
 * Returns the value of a required environment variable.
 *
 * Throws an error if the variable is not defined, allowing callers to treat
 * the returned value as a non-optional string.
 *
 * @param {string} name - The name of the environment variable.
 * @param {string=} defaultValue - The default value of the environment variable when unset.
 * @returns The environment variable's value.
 * @throws {Error} If the environment variable is not defined.
 */
const requireEnv = (name, defaultValue) => {
  const value = process.env[name];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};
// import fetch from 'node-fetch';

const API_ENDPOINT = requireEnv("API_ENDPOINT");
// default to Batumi
const CITY = requireEnv("CITY", "ბათუმი");

const FIRESTORE_COLLECTION_ID = requireEnv("FIRESTORE_COLLECTION_ID");
const FIRESTORE_DATABASE_ID = requireEnv("FIRESTORE_DATABASE_ID");
const GEMINI_API_KEY = requireEnv("GEMINI_API_KEY");

const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");
const TELEGRAM_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");

const db = new Firestore({
  databaseId: FIRESTORE_DATABASE_ID,
});
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const TIMEZONE_OFFSET = "+04:00";
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * Checks if the disconnection date (relative to UTC+4) happened more than a day ago.
 * 
 * @param {string} dateStr - Date string in "YYYY-MM-DD HH:mm" format.
 * @returns {boolean} True if the date is in the last 24 hours, false otherwise.
 */
const isDisconnectedMoreThanDayAgo = (dateStr) => {
  if (!dateStr) return false;

  // 1. Format the raw string to ISO 8601 with the UTC+4 offset
  // "2026-07-16 23:35" -> "2026-07-16T23:35+04:00"
  const formattedIsoString = dateStr.replace(' ', 'T') + TIMEZONE_OFFSET;
  const disconnectionDate = new Date(formattedIsoString);

  // 2. Set up current time and the "one day ago" boundary
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - ONE_DAY_IN_MS);

  // 3. Return false if it happened within the last 24 hours
  return disconnectionDate <= oneDayAgo;
}

/**
 * Express request object provided by GCP Cloud Functions.
 * @typedef {import('express').Request} Request
 */

/**
 * Express response object provided by GCP Cloud Functions.
 * @typedef {import('express').Response} Response
 */

/**
 * Periodically fetches power outage records from the utility API,
 * filters out already processed tasks via Firestore, translates
 * Georgian details to English via Gemini, and broadcasts alerts to Telegram.
 * @param {Request} _req - The incoming HTTP request payload from Cloud Scheduler.
 * @param {Response} res - The HTTP response object used to signal execution status.
 * @returns {Promise<void>}
 */
export const checkPowerOutages = async (_req, res) => {
  try {
    const requestBody = JSON.stringify({
      search: CITY,
    });
    const response = await fetch(API_ENDPOINT, {
      body: requestBody,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
      },
      method: "POST",
    });
    const json = await response.json();

    if (json.status !== 200 || !json.data || json.data.length === 0) {
      res.status(200).send("No data or API error.");
      return;
    }

    const tasks = json.data;
    const collectionRef = db.collection(FIRESTORE_COLLECTION_ID);

    for (const task of tasks) {
      const taskIdStr = String(task.taskId);
      const docRef = collectionRef.doc(taskIdStr);
      const doc = await docRef.get();

      if (doc.exists) {
        continue; // Skip already processed items
      }

      console.log(`Processing task ${taskIdStr}...`);

      if (isDisconnectedMoreThanDayAgo(task.disconnectionDate)) {
        await docRef.set({
          processedAt: new Date().toISOString(),
          taskName: task.taskName,
        });
        console.log(`Task ${taskIdStr} was disconnected too long ago, skipping`);
        continue;
      }

      // 1. Combine Name and Area into a clear translation prompt
      const prompt = `
        Translate this Georgian utility outage information into English.
        
        Task Name/Reason: "${task.taskName}"
        Affected Areas/Streets: "${task.disconnectionArea}"
        
        Guidelines:
        - Keep street/location names recognizable (e.g., "Sherif Khimshiashvili", "Shota Rustaveli", "Gorgiladze").
        - Clean up repeated or messy street listings into a legible comma-separated list.
      `;

      // 2. Use Structured Outputs to guarantee a clean JSON response from Gemini
      const aiResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              englishName: {
                type: Type.STRING,
                description:
                  "The translated reasons or actions happening during the outage",
              },
              englishArea: {
                type: Type.STRING,
                description:
                  "The cleaned and translated list of streets and locations affected",
              },
            },
            required: ["englishName", "englishArea"],
          },
        },
      });

      // Parse the structured translation
      if (!aiResponse.text) {
        console.error(`Error translating task ${task.taskId}`);
        continue;
      }

      const translation = JSON.parse(aiResponse.text.trim());

      // Hard check for some rules in my case
      const regionName =
        task.regionName === "დასავლეთ რეგიონი"
          ? "Western region"
          : task.regionName;
      const cityName = task.scName === "ბათუმი" ? "Batumi" : task.scName;

      // 3. Format Telegram post using HTML (more resilient to raw text symbols than Markdown)
      const telegramMessage = `
⚠️ <b>New Power Outage Alert #${task.taskName}</b>
<b>📍 Region:</b> ${regionName} (${cityName})

<b>📝 Details:</b> ${translation.englishName}
<b>🛣️ Affected Areas:</b> ${translation.englishArea}

<b>👥 Affected Customers:</b> ${task.scEffectedCustomers}
<b>🕒 Disconnection:</b> ${task.disconnectionDate}
<b>🔋 Reconnection:</b> ${task.reconnectionDate}
      `.trim();

      // 4. Dispatch to Telegram
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: telegramMessage,
          parse_mode: "HTML", // Swapped to HTML to safely prevent markup crash bugs
        }),
      });

      // 5. Commit to Firestore cache
      await docRef.set({
        processedAt: new Date().toISOString(),
        taskName: task.taskName,
      });
    }

    res.status(200).send("Outage scan and translation complete.");
  } catch (error) {
    console.error("Execution Failed:", error);
    res.status(500).send("Internal Server Error");
  }
};
