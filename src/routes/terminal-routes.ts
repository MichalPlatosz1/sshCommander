import { Router, type Request, type Response } from "express";
import multer from "multer";
import {
  resetTerminalConnection,
  uploadFileToTerminalCurrentDirectory,
} from "../ssh-terminal-bridge.js";
import { TerminalRepository } from "../services/terminal-repository.js";
import { TerminalEventBus } from "../services/terminal-event-bus.js";
import type { CreateTerminalRequest } from "../types/terminal.js";

/**
 * API routes for terminal CRUD and SSH file uploads.
 */
export class TerminalRoutes {
  private readonly upload = multer({ storage: multer.memoryStorage() });

  constructor(
    private readonly repository: TerminalRepository,
    private readonly eventBus: TerminalEventBus,
  ) {}

  buildRouter(): Router {
    const router = Router();

    router.get("/terminals", this.handleListTerminals);
    router.post("/terminals", this.handleCreateTerminal);
    router.put("/terminals/:terminalId", this.handleUpdateTerminal);
    router.post(
      "/terminals/:terminalId/upload",
      this.upload.single("file"),
      this.handleUploadToTerminal,
    );

    return router;
  }

  private handleListTerminals = (_req: Request, res: Response) => {
    return res.json(this.repository.listAll());
  };

  private handleCreateTerminal = (req: Request, res: Response) => {
    const result = this.repository.create(req.body as CreateTerminalRequest);
    if (!result.terminal) {
      return res.status(400).json({ message: result.error });
    }

    return res.status(201).json(result.terminal);
  };

  private handleUpdateTerminal = (req: Request, res: Response) => {
    const terminalId = req.params.terminalId;
    if (!terminalId) {
      return res.status(400).json({ message: "Missing terminal id." });
    }

    const result = this.repository.update(
      terminalId,
      req.body as CreateTerminalRequest,
    );

    if (!result.terminal) {
      const statusCode = result.error === "Terminal not found." ? 404 : 400;
      return res.status(statusCode).json({ message: result.error });
    }

    resetTerminalConnection(terminalId);
    return res.json(result.terminal);
  };

  private handleUploadToTerminal = async (req: Request, res: Response) => {
    const terminalId = req.params.terminalId;
    if (!terminalId) {
      return res.status(400).json({ message: "Missing terminal id." });
    }

    console.log("[upload] Request received", {
      terminalId,
      hasFile: Boolean(req.file),
    });

    const terminal = this.repository.getById(terminalId);
    if (!terminal) {
      return res.status(404).json({ message: "Terminal not found." });
    }

    if ("type" in terminal && terminal.type === "local") {
      return res
        .status(400)
        .json({ message: "Local terminals do not support SCP upload." });
    }

    const uploadedFile = req.file;
    if (!uploadedFile) {
      return res.status(400).json({ message: "Missing file payload." });
    }

    console.log("[upload] File payload", {
      terminalId,
      name: uploadedFile.originalname,
      size: uploadedFile.size,
      mimeType: uploadedFile.mimetype,
    });

    if (uploadedFile.size <= 0) {
      return res.status(400).json({ message: "Uploaded file is empty." });
    }

    try {
      console.log("[upload] Uploading to remote terminal cwd", {
        terminalId,
        fileName: uploadedFile.originalname,
      });

      const remotePath = await uploadFileToTerminalCurrentDirectory(
        terminal,
        uploadedFile.originalname,
        uploadedFile.buffer,
        this.eventBus.sendOutput.bind(this.eventBus),
      );

      console.log("[upload] Upload success", {
        terminalId,
        remotePath,
      });

      return res.status(201).json({
        terminalId,
        fileName: uploadedFile.originalname,
        size: uploadedFile.size,
        remotePath,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown upload error";
      console.log("[upload] Upload failed", {
        terminalId,
        message,
      });
      this.eventBus.sendOutput(terminalId, `[scp error] ${message}\r\n`);
      return res.status(500).json({ message });
    }
  };
}
