import { describe, expect, it } from "vitest";
import { type FsError, fsError, mapSshError, sftpStatusToErrno } from "./errors.js";

describe("sftpStatusToErrno", () => {
  it("maps SSH_FX_NO_SUCH_FILE (3) → ENOENT", () => {
    expect(sftpStatusToErrno(3)).toBe("ENOENT");
  });

  it("maps SSH_FX_PERMISSION_DENIED (4) → EACCES", () => {
    expect(sftpStatusToErrno(4)).toBe("EACCES");
  });

  it("maps SSH_FX_FILE_ALREADY_EXISTS (11) → EEXIST", () => {
    expect(sftpStatusToErrno(11)).toBe("EEXIST");
  });

  it("maps SSH_FX_NOT_A_DIRECTORY (20) → ENOTDIR", () => {
    expect(sftpStatusToErrno(20)).toBe("ENOTDIR");
  });

  it("returns undefined for codes with no errno analog", () => {
    expect(sftpStatusToErrno(1)).toBeUndefined(); // SSH_FX_EOF
    expect(sftpStatusToErrno(999)).toBeUndefined();
  });
});

describe("fsError", () => {
  it("builds an Error carrying a .code string", () => {
    const err: FsError = fsError("ENOENT", "no such file: /x");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ENOENT");
    expect(err.message).toBe("no such file: /x");
  });
});

describe("mapSshError", () => {
  it("maps a numeric SFTP status code on .code → ENOENT", () => {
    const err = mapSshError(Object.assign(new Error("fail"), { code: 3 }), "readFile /x");
    expect(err.code).toBe("ENOENT");
    expect(err.message).toContain("readFile /x");
    expect(err.message).toContain("fail");
  });

  it("maps an SFTP_* string code → ENOENT", () => {
    const err = mapSshError(
      Object.assign(new Error("nope"), { code: "SFTP_STATUS_NO_SUCH_FILE" }),
      "stat /y",
    );
    expect(err.code).toBe("ENOENT");
  });

  it("maps an SFTP permission-denied string → EACCES", () => {
    const err = mapSshError(
      Object.assign(new Error("denied"), { code: "SFTP_STATUS_PERMISSION_DENIED" }),
      "readFile /y",
    );
    expect(err.code).toBe("EACCES");
  });

  it("falls back to message-text sniffing when .code is absent (No such file)", () => {
    const err = mapSshError(new Error("No such file or directory"), "readFile /z");
    expect(err.code).toBe("ENOENT");
  });

  it("falls back to message-text sniffing for permission denied", () => {
    const err = mapSshError(new Error("Permission denied"), "writeFile /z");
    expect(err.code).toBe("EACCES");
  });

  it("surfaces HOST KEY CHANGED as EHOSTUNREACH", () => {
    const err = mapSshError(new Error("HOST KEY CHANGED for localhost"), "connect");
    expect(err.code).toBe("EHOSTUNREACH");
  });

  it("defaults unrecognized errors to EIO", () => {
    const err = mapSshError(new Error("something weird happened"), "readdir /a");
    expect(err.code).toBe("EIO");
  });

  it("never throws — maps a non-Error value", () => {
    const err = mapSshError("just a string", "readdir /a");
    expect(err.code).toBe("EIO");
    expect(err.message).toContain("just a string");
  });

  it("includes the context prefix in the message", () => {
    const err = mapSshError(new Error("boom"), "writeFile /path/file");
    expect(err.message).toContain("writeFile /path/file");
  });
});
