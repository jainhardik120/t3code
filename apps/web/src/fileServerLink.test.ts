import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./env", () => ({ isElectron: false }));

const { fileServerHref } = await import("./fileServerLink");

describe("fileServerHref", () => {
  it("prefixes an absolute path with the file server mount", () => {
    expect(fileServerHref("/home/user/shot.png")).toBe("/files/home/user/shot.png");
  });

  it("encodes spaces and non-ascii segments", () => {
    expect(fileServerHref("/home/user/my notes/report v2.pdf")).toBe(
      "/files/home/user/my%20notes/report%20v2.pdf",
    );
    expect(fileServerHref("/home/üser/файл.txt")).toBe(
      "/files/home/%C3%BCser/%D1%84%D0%B0%D0%B9%D0%BB.txt",
    );
  });

  it("keeps existing percent signs escaped rather than double-decoding", () => {
    expect(fileServerHref("/tmp/100%25.png")).toBe("/files/tmp/100%2525.png");
  });

  it("drops a line or line:column suffix the file server cannot address", () => {
    expect(fileServerHref("/repo/src/main.ts:42")).toBe("/files/repo/src/main.ts");
    expect(fileServerHref("/repo/src/main.ts:42:7")).toBe("/files/repo/src/main.ts");
  });

  it("returns null for paths the file server cannot serve", () => {
    expect(fileServerHref("src/main.ts")).toBeNull();
    expect(fileServerHref("./relative.ts")).toBeNull();
    expect(fileServerHref("C:/Users/mike/main.ts")).toBeNull();
    expect(fileServerHref("\\\\share\\file.txt")).toBeNull();
    expect(fileServerHref("/etc/pass\0wd")).toBeNull();
    expect(fileServerHref("")).toBeNull();
  });
});

describe("fileServerHref in the desktop app", () => {
  it("returns null so the file opens in the local editor instead", async () => {
    vi.resetModules();
    vi.doMock("./env", () => ({ isElectron: true }));
    const desktop = await import("./fileServerLink");
    expect(desktop.fileServerHref("/home/user/shot.png")).toBeNull();
  });
});
