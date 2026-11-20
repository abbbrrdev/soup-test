const KEY = "soup_tracker_api_key";
const NAME = "soup_tracker_project_name";

export function getStoredKey(): string | null {
  return localStorage.getItem(KEY);
}

export function setStoredKey(key: string, projectName: string) {
  localStorage.setItem(KEY, key);
  localStorage.setItem(NAME, projectName);
}

export function getStoredProjectName(): string | null {
  return localStorage.getItem(NAME);
}

export function clearStoredKey() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(NAME);
}
