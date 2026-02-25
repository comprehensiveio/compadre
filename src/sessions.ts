import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const SESSION_DIR = join(process.cwd(), ".sessions");
const SESSION_FILE = join(SESSION_DIR, "thread-sessions.json");

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(map: Record<string, string>) {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(map));
}

export function getSessionId(threadId: string): string | undefined {
  return load()[threadId];
}

export function setSessionId(threadId: string, sessionId: string) {
  const map = load();
  map[threadId] = sessionId;
  save(map);
}
