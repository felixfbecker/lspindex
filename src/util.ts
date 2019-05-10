import { fileURLToPath } from "url";

export function* iterateParentDirectories(path: string): Iterable<string> {
  const segments = path.split("/");
  while (segments.pop()) {
    yield segments.join("/");
  }
}
