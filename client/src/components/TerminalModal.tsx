import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalWindowPosition = {
  x: number;
  y: number;
};

type TerminalWindowSize = {
  width: number;
  height: number;
};

type SnapPreview = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ResizeDirection =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

type TerminalModalProps = {
  terminal: {
    id: string;
    name: string;
    type?: "ssh" | "local";
    ssh?: {
      targetMachine: string;
      targetPort: number;
    };
  };
  outputLines: string[];
  uploadStatus?: {
    phase: "uploading" | "finishing" | "done";
    fileName: string;
    fileIndex: number;
    totalFiles: number;
    loadedBytes: number;
    totalBytes: number;
    percent: number;
  };
  onSendRawInput: (input: string) => void;
  onSshCommanderCommand: (commandLine: string) => void;
  onSshCommanderComplete: (commandLine: string) => Promise<string | undefined>;
  onDropFiles: (files: File[]) => Promise<void>;
  onResize: (cols: number, rows: number) => void;
  position: TerminalWindowPosition;
  onPositionChange: (position: TerminalWindowPosition) => void;
  size: TerminalWindowSize;
  onSizeChange: (size: TerminalWindowSize) => void;
  zIndex: number;
  onFocus: () => void;
  onClose: () => void;
};

function TerminalModal({
  terminal,
  outputLines,
  uploadStatus,
  onSendRawInput,
  onSshCommanderCommand,
  onSshCommanderComplete,
  onDropFiles,
  onResize,
  position,
  onPositionChange,
  size,
  onSizeChange,
  zIndex,
  onFocus,
  onClose,
}: TerminalModalProps) {
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 220;
  const SNAP_THRESHOLD = 24;

  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const resizableWrapperRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenChunksRef = useRef(0);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const onSendRawInputRef = useRef(onSendRawInput);
  const onSshCommanderCommandRef = useRef(onSshCommanderCommand);
  const onSshCommanderCompleteRef = useRef(onSshCommanderComplete);
  const onResizeRef = useRef(onResize);
  const snapPreviewRef = useRef<SnapPreview | null>(null);
  const preSnapBoundsRef = useRef<WindowBounds | null>(null);
  const isSnappedRef = useRef(false);
  const inputBufferRef = useRef("");
  const heldInputRef = useRef("");
  const linePassthroughRef = useRef(false);
    const terminalHostLabel =
      terminal.type === "local"
        ? "local"
        : terminal.ssh
          ? `${terminal.ssh.targetMachine}:${terminal.ssh.targetPort}`
          : undefined;

  const sshCommandHistoryRef = useRef<string[]>([]);
  const sshHistoryIndexRef = useRef<number>(-1);
  const completionPendingRef = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const uploadBadgeText = uploadStatus
    ? uploadStatus.phase === "uploading"
      ? `Uploading ${uploadStatus.fileIndex}/${uploadStatus.totalFiles}: ${uploadStatus.fileName} (${uploadStatus.percent}%)`
      : uploadStatus.phase === "finishing"
        ? `Finalizing ${uploadStatus.fileName}...`
        : `Uploaded ${uploadStatus.fileName}`
    : null;

  const isCommandInterceptEnabled = terminal.type !== "local";

  useEffect(() => {
    onSendRawInputRef.current = onSendRawInput;
  }, [onSendRawInput]);

  useEffect(() => {
    onSshCommanderCommandRef.current = onSshCommanderCommand;
  }, [onSshCommanderCommand]);

  useEffect(() => {
    onSshCommanderCompleteRef.current = onSshCommanderComplete;
  }, [onSshCommanderComplete]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    const xterm = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: "#0b0f14",
        foreground: "#d1fae5",
      },
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    fitAddon.fit();
    xterm.focus();

    const flushHeldInput = () => {
      if (!heldInputRef.current) {
        return;
      }

      onSendRawInputRef.current(heldInputRef.current);
      heldInputRef.current = "";
      linePassthroughRef.current = true;
    };

    const refreshInterceptState = () => {
      const trimmedStart = inputBufferRef.current.replace(/^\s+/, "");
      if (!trimmedStart) {
        return;
      }

      const firstWhitespaceIndex = trimmedStart.search(/\s/);
      if (firstWhitespaceIndex === -1) {
        if (!"sshCommander".startsWith(trimmedStart)) {
          flushHeldInput();
        }
        return;
      }

      const firstToken = trimmedStart.slice(0, firstWhitespaceIndex);
      if (!"sshCommander".startsWith(firstToken)) {
        flushHeldInput();
      }
    };

    const replaceInterceptedLine = (nextLine: string) => {
      const currentLength = inputBufferRef.current.length;
      for (let i = 0; i < currentLength; i += 1) {
        xterm.write("\b \b");
      }

      heldInputRef.current = nextLine;
      inputBufferRef.current = nextLine;
      if (nextLine) {
        xterm.write(nextLine);
      }
    };

    const handleHistoryNavigation = (direction: "up" | "down") => {
      if (linePassthroughRef.current) {
        onSendRawInputRef.current(direction === "up" ? "\u001b[A" : "\u001b[B");
        return;
      }

      const history = sshCommandHistoryRef.current;
      if (history.length === 0) {
        return;
      }

      if (direction === "up") {
        const nextIndex =
          sshHistoryIndexRef.current === -1
            ? history.length - 1
            : Math.max(0, sshHistoryIndexRef.current - 1);
        sshHistoryIndexRef.current = nextIndex;
        replaceInterceptedLine(history[nextIndex] ?? "");
        return;
      }

      if (sshHistoryIndexRef.current === -1) {
        return;
      }

      const nextIndex = sshHistoryIndexRef.current + 1;
      if (nextIndex >= history.length) {
        sshHistoryIndexRef.current = -1;
        replaceInterceptedLine("");
        return;
      }

      sshHistoryIndexRef.current = nextIndex;
      replaceInterceptedLine(history[nextIndex] ?? "");
    };

    const handleTabCompletion = () => {
      if (linePassthroughRef.current || completionPendingRef.current) {
        onSendRawInputRef.current("\t");
        return;
      }

      const currentLine = inputBufferRef.current;
      const trimmedStart = currentLine.replace(/^\s+/, "");
      if (!trimmedStart || !"sshCommander".startsWith(trimmedStart.split(/\s+/)[0] ?? "")) {
        flushHeldInput();
        onSendRawInputRef.current("\t");
        return;
      }

      const hasTrailingSpace = /\s$/.test(trimmedStart);
      const tokens = trimmedStart.split(/\s+/).filter(Boolean);
      const firstToken = tokens[0] ?? "";

      if (tokens.length === 1 && !hasTrailingSpace) {
        if ("sshCommander".startsWith(firstToken)) {
          replaceInterceptedLine("sshCommander ");
          return;
        }
      }

      if (firstToken !== "sshCommander") {
        return;
      }

      const subcommandOptions = ["edit", "--help", "-h"];

      if (tokens.length === 1 && hasTrailingSpace) {
        xterm.write(`\r\n${subcommandOptions.join("  ")}\r\n${inputBufferRef.current}`);
        return;
      }

      if (tokens.length <= 2 && !hasTrailingSpace) {
        const typedSubcommand = tokens[1] ?? "";
        const matches = subcommandOptions.filter((option) => option.startsWith(typedSubcommand));

        if (matches.length === 1) {
          replaceInterceptedLine(`sshCommander ${matches[0]} `);
          return;
        }

        if (matches.length > 1) {
          xterm.write(`\r\n${matches.join("  ")}\r\n${inputBufferRef.current}`);
          return;
        }
      }

      if ((tokens[1] ?? "") !== "edit") {
        return;
      }

      completionPendingRef.current = true;
      onSshCommanderCompleteRef.current(currentLine)
        .then((completedLine) => {
          if (completedLine && !linePassthroughRef.current) {
            replaceInterceptedLine(completedLine);
          }
        })
        .finally(() => {
          completionPendingRef.current = false;
        });
    };

    const handleInputCharacter = (character: string) => {
      if (character === "\r") {
        const commandLine = inputBufferRef.current.trim();
        const isSshCommander = commandLine.startsWith("sshCommander");

        if (isSshCommander && !linePassthroughRef.current) {
          xterm.write("\r\n");
          onSshCommanderCommandRef.current(commandLine);
          sshCommandHistoryRef.current.push(commandLine);
          if (sshCommandHistoryRef.current.length > 100) {
            sshCommandHistoryRef.current.shift();
          }
          sshHistoryIndexRef.current = -1;
        } else {
          if (!linePassthroughRef.current) {
            flushHeldInput();
          }
          onSendRawInputRef.current("\r");
        }

        inputBufferRef.current = "";
        heldInputRef.current = "";
        linePassthroughRef.current = false;
        return;
      }

      if (character === "\n") {
        return;
      }

      if (character === "\t") {
        handleTabCompletion();
        return;
      }

      if (character === "\u007F" || character === "\b") {
        if (!linePassthroughRef.current) {
          if (inputBufferRef.current.length > 0) {
            heldInputRef.current += character;
            xterm.write("\b \b");
            inputBufferRef.current = inputBufferRef.current.slice(0, -1);
          }
        } else {
          onSendRawInputRef.current(character);
          inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        }
        refreshInterceptState();
        return;
      }

      if (!linePassthroughRef.current) {
        heldInputRef.current += character;
        inputBufferRef.current += character;
        refreshInterceptState();

        if (!linePassthroughRef.current) {
          xterm.write(character);
        }

        return;
      }

      onSendRawInputRef.current(character);

      if (character >= " " || character === "\t") {
        inputBufferRef.current += character;
      }
    };

    xterm.onData((data: string) => {
      if (!isCommandInterceptEnabled) {
        onSendRawInputRef.current(data);
        return;
      }

      if (data === "\u001b[A") {
        handleHistoryNavigation("up");
        return;
      }

      if (data === "\u001b[B") {
        handleHistoryNavigation("down");
        return;
      }

      for (const character of data) {
        handleInputCharacter(character);
      }
    });

    let resizeRafId: number | null = null;
    let initialResizeRafId: number | null = null;
    let initialResizeTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const publishResize = () => {
      if (xtermRef.current !== xterm || fitAddonRef.current !== fitAddon) {
        return;
      }

      try {
        fitAddon.fit();
      } catch {
        return;
      }

      const cols = xterm.cols;
      const rows = xterm.rows;

      if (
        cols > 0 &&
        rows > 0 &&
        (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)
      ) {
        lastSizeRef.current = { cols, rows };
        onResizeRef.current(cols, rows);
      }
    };

    const handleResize = () => publishResize();
    window.addEventListener("resize", handleResize);

    const observerTarget = terminalContainerRef.current ?? container;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
      }

      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        publishResize();
      });
    });
    resizeObserver.observe(observerTarget);

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    initialResizeRafId = requestAnimationFrame(() => publishResize());
    initialResizeTimeoutId = setTimeout(() => publishResize(), 60);

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();

      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
      }
      if (initialResizeRafId !== null) {
        cancelAnimationFrame(initialResizeRafId);
      }
      if (initialResizeTimeoutId !== null) {
        clearTimeout(initialResizeTimeoutId);
      }

      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isCommandInterceptEnabled]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) {
      return;
    }

    xterm.clear();
    xterm.reset();
    writtenChunksRef.current = 0;
    lastSizeRef.current = { cols: 0, rows: 0 };
    try {
      fitAddonRef.current?.fit();
    } catch {
      return;
    }
    if (xterm.cols > 0 && xterm.rows > 0) {
      onResizeRef.current(xterm.cols, xterm.rows);
      lastSizeRef.current = { cols: xterm.cols, rows: xterm.rows };
    }
    xterm.focus();
    inputBufferRef.current = "";
    heldInputRef.current = "";
    linePassthroughRef.current = false;
    sshHistoryIndexRef.current = -1;
  }, [terminal.id]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) {
      return;
    }

    for (let i = writtenChunksRef.current; i < outputLines.length; i += 1) {
      xterm.write(outputLines[i]);
    }

    writtenChunksRef.current = outputLines.length;
    xterm.scrollToBottom();
  }, [outputLines]);

  const handleDragStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const shellWindow = windowRef.current;
    const parentElement = shellWindow?.parentElement;
    if (!shellWindow || !parentElement) {
      return;
    }

    const windowRect = shellWindow.getBoundingClientRect();
    const parentRect = parentElement.getBoundingClientRect();
    const dragOffsetX = event.clientX - windowRect.left;
    const dragOffsetY = event.clientY - windowRect.top;

    const clearPreview = () => {
      const previewElement = shellWindow.parentElement?.querySelector(
        `[data-snap-preview='${terminal.id}']`,
      ) as HTMLDivElement | null;
      if (previewElement) {
        previewElement.style.display = "none";
      }
      snapPreviewRef.current = null;
    };

    const updatePreview = (preview: SnapPreview | null) => {
      const previewElement = shellWindow.parentElement?.querySelector(
        `[data-snap-preview='${terminal.id}']`,
      ) as HTMLDivElement | null;

      if (!previewElement) {
        return;
      }

      if (!preview) {
        previewElement.style.display = "none";
        snapPreviewRef.current = null;
        return;
      }

      previewElement.style.display = "block";
      previewElement.style.left = `${preview.x}px`;
      previewElement.style.top = `${preview.y}px`;
      previewElement.style.width = `${preview.width}px`;
      previewElement.style.height = `${preview.height}px`;
      snapPreviewRef.current = preview;
    };

    const detectSnapPreview = (
      nextX: number,
      nextY: number,
      width: number,
      height: number,
    ): SnapPreview | null => {
      const nearLeft = nextX <= SNAP_THRESHOLD;
      const nearRight = nextX + width >= parentRect.width - SNAP_THRESHOLD;
      const nearTop = nextY <= SNAP_THRESHOLD;
      const nearBottom = nextY + height >= parentRect.height - SNAP_THRESHOLD;

      if (nearTop && nearLeft) {
        return {
          x: 0,
          y: 0,
          width: parentRect.width / 2,
          height: parentRect.height / 2,
        };
      }

      if (nearTop && nearRight) {
        return {
          x: parentRect.width / 2,
          y: 0,
          width: parentRect.width / 2,
          height: parentRect.height / 2,
        };
      }

      if (nearBottom && nearLeft) {
        return {
          x: 0,
          y: parentRect.height / 2,
          width: parentRect.width / 2,
          height: parentRect.height / 2,
        };
      }

      if (nearBottom && nearRight) {
        return {
          x: parentRect.width / 2,
          y: parentRect.height / 2,
          width: parentRect.width / 2,
          height: parentRect.height / 2,
        };
      }

      if (nearLeft) {
        return {
          x: 0,
          y: 0,
          width: parentRect.width / 2,
          height: parentRect.height,
        };
      }

      if (nearRight) {
        return {
          x: parentRect.width / 2,
          y: 0,
          width: parentRect.width / 2,
          height: parentRect.height,
        };
      }

      if (nearTop) {
        return {
          x: 0,
          y: 0,
          width: parentRect.width,
          height: parentRect.height / 2,
        };
      }

      if (nearBottom) {
        return {
          x: 0,
          y: parentRect.height / 2,
          width: parentRect.width,
          height: parentRect.height / 2,
        };
      }

      return null;
    };

    let activeWidth = windowRect.width;
    let activeHeight = windowRect.height;
    let activeOffsetX = dragOffsetX;
    let activeOffsetY = dragOffsetY;
    let didRestoreFromSnap = false;
    let lastPosition = { x: position.x, y: position.y };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (isSnappedRef.current && !didRestoreFromSnap && preSnapBoundsRef.current) {
        const restoreBounds = preSnapBoundsRef.current;
        const pointerRatioX = windowRect.width > 0 ? dragOffsetX / windowRect.width : 0.5;

        activeWidth = restoreBounds.width;
        activeHeight = restoreBounds.height;
        activeOffsetX = Math.max(0, Math.min(activeWidth, activeWidth * pointerRatioX));
        activeOffsetY = Math.max(0, Math.min(activeHeight, dragOffsetY));

        onSizeChange({ width: restoreBounds.width, height: restoreBounds.height });
        isSnappedRef.current = false;
        didRestoreFromSnap = true;
      }

      const nextX = moveEvent.clientX - parentRect.left - activeOffsetX;
      const nextY = moveEvent.clientY - parentRect.top - activeOffsetY;
      const maxX = Math.max(0, parentRect.width - activeWidth);
      const maxY = Math.max(0, parentRect.height - activeHeight);

      const preview = detectSnapPreview(nextX, nextY, activeWidth, activeHeight);
      updatePreview(preview);

      lastPosition = {
        x: Math.max(0, Math.min(nextX, maxX)),
        y: Math.max(0, Math.min(nextY, maxY)),
      };

      onPositionChange(lastPosition);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);

      if (snapPreviewRef.current) {
        const preview = snapPreviewRef.current;
        preSnapBoundsRef.current = {
          x: lastPosition.x,
          y: lastPosition.y,
          width: activeWidth,
          height: activeHeight,
        };
        isSnappedRef.current = true;

        onPositionChange({ x: preview.x, y: preview.y });
        onSizeChange({
          width: Math.max(MIN_WIDTH, Math.floor(preview.width)),
          height: Math.max(MIN_HEIGHT, Math.floor(preview.height)),
        });
      } else {
        isSnappedRef.current = false;
      }

      clearPreview();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleResizeStart = (
    direction: ResizeDirection,
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const shellWindow = windowRef.current;
    const parentElement = shellWindow?.parentElement;
    if (!shellWindow || !parentElement) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = { ...position };
    const startSize = { ...size };
    const parentRect = parentElement.getBoundingClientRect();

    isSnappedRef.current = false;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let nextX = startPosition.x;
      let nextY = startPosition.y;
      let nextWidth = startSize.width;
      let nextHeight = startSize.height;

      if (direction.includes("e")) {
        nextWidth = Math.max(MIN_WIDTH, startSize.width + deltaX);
      }

      if (direction.includes("s")) {
        nextHeight = Math.max(MIN_HEIGHT, startSize.height + deltaY);
      }

      if (direction.includes("w")) {
        const maxLeftShift = startSize.width - MIN_WIDTH;
        const appliedShift = Math.min(maxLeftShift, deltaX);
        nextX = startPosition.x + appliedShift;
        nextWidth = startSize.width - appliedShift;
      }

      if (direction.includes("n")) {
        const maxTopShift = startSize.height - MIN_HEIGHT;
        const appliedShift = Math.min(maxTopShift, deltaY);
        nextY = startPosition.y + appliedShift;
        nextHeight = startSize.height - appliedShift;
      }

      nextX = Math.max(0, Math.min(nextX, parentRect.width - MIN_WIDTH));
      nextY = Math.max(0, Math.min(nextY, parentRect.height - MIN_HEIGHT));
      nextWidth = Math.min(nextWidth, parentRect.width - nextX);
      nextHeight = Math.min(nextHeight, parentRect.height - nextY);

      onPositionChange({ x: nextX, y: nextY });
      onSizeChange({ width: nextWidth, height: nextHeight });
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleFileDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isDragOver) {
      setIsDragOver(true);
    }
  };

  const handleFileDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  };

  const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    if (terminal.type === "local") {
      return;
    }

    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) {
      return;
    }

    onDropFiles(files).catch(() => {
      // App-level error modal displays failure.
    });
  };

  return (
    <>
      <div
        data-snap-preview={terminal.id}
        className="pointer-events-none absolute hidden rounded-lg border-2 border-primary/80 bg-primary/10"
        style={{ zIndex: zIndex - 1 }}
      />

      <div
        ref={windowRef}
        className="absolute"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          zIndex,
        }}
        onMouseDown={onFocus}
      >
        <div
          ref={resizableWrapperRef}
          className="relative rounded-lg border border-base-300 bg-[#0b0f14] text-green-200 shadow-xl"
          style={{
            width: `${size.width}px`,
            height: `${size.height}px`,
            overflow: "hidden",
          }}
        >
          <div
            className="absolute inset-y-0 left-0 w-1 cursor-ew-resize"
            onMouseDown={(event) => handleResizeStart("w", event)}
          />
          <div
            className="absolute inset-y-0 right-0 w-1 cursor-ew-resize"
            onMouseDown={(event) => handleResizeStart("e", event)}
          />
          <div
            className="absolute inset-x-0 top-0 h-1 cursor-ns-resize"
            onMouseDown={(event) => handleResizeStart("n", event)}
          />
          <div
            className="absolute inset-x-0 bottom-0 h-1 cursor-ns-resize"
            onMouseDown={(event) => handleResizeStart("s", event)}
          />
          <div
            className="absolute left-0 top-0 h-3 w-3 cursor-nwse-resize"
            onMouseDown={(event) => handleResizeStart("nw", event)}
          />
          <div
            className="absolute right-0 top-0 h-3 w-3 cursor-nesw-resize"
            onMouseDown={(event) => handleResizeStart("ne", event)}
          />
          <div
            className="absolute bottom-0 left-0 h-3 w-3 cursor-nesw-resize"
            onMouseDown={(event) => handleResizeStart("sw", event)}
          />
          <div
            className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
            onMouseDown={(event) => handleResizeStart("se", event)}
          />

        <div
          className="flex cursor-move select-none items-center gap-2 border-b border-base-300/40 bg-[#1a1f29] px-3 py-2"
          onMouseDown={handleDragStart}
        >
          <span className="h-3 w-3 rounded-full bg-red-500" />
          <span className="h-3 w-3 rounded-full bg-yellow-400" />
          <span className="h-3 w-3 rounded-full bg-green-500" />
          <span className="ml-2 text-xs text-slate-300">
            {terminal.name} ({terminal.id})
          </span>
          {terminalHostLabel ? (
            <span className="text-[11px] text-slate-400">[{terminalHostLabel}]</span>
          ) : null}
          {uploadBadgeText ? (
            <span
              className={`ml-2 rounded px-2 py-0.5 text-[10px] ${uploadStatus?.phase === "done" ? "bg-emerald-600/30 text-emerald-200" : "bg-sky-600/30 text-sky-200"}`}
              title={uploadBadgeText}
            >
              {uploadBadgeText}
            </span>
          ) : null}
          <button
            className="btn btn-ghost btn-xs ml-auto text-slate-300 hover:bg-base-300/20"
            onClick={onClose}
            title="Close terminal window"
            aria-label={`Close ${terminal.name}`}
          >
            ✕
          </button>
        </div>

        <div
          className="relative space-y-3 p-2 font-mono text-sm"
          onDragOver={handleFileDragOver}
          onDragEnter={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
        >
          <div
            ref={terminalContainerRef}
            className="h-[calc(100%-2rem)] min-h-[140px] overflow-hidden rounded border border-base-300/40 bg-black/30"
            style={{ height: `${Math.max(140, size.height - 56)}px` }}
          />
          {uploadStatus && uploadStatus.phase !== "done" ? (
            <div className="pointer-events-none absolute inset-x-2 bottom-3 rounded border border-sky-400/30 bg-slate-900/85 p-2 text-xs text-slate-200">
              <div className="mb-1 truncate">
                {uploadStatus.phase === "finishing"
                  ? `Finalizing ${uploadStatus.fileName}...`
                  : `Uploading ${uploadStatus.fileName} (${uploadStatus.fileIndex}/${uploadStatus.totalFiles})`}
              </div>
              <progress
                className="progress progress-info h-1.5 w-full"
                value={uploadStatus.percent}
                max={100}
              />
              <div className="mt-1 text-[10px] text-slate-400">
                {uploadStatus.percent}% • {Math.min(uploadStatus.loadedBytes, uploadStatus.totalBytes)} / {uploadStatus.totalBytes} bytes
              </div>
            </div>
          ) : null}
          {isDragOver ? (
            <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded border-2 border-dashed border-primary/80 bg-primary/10 text-center text-sm font-medium text-primary-content">
              Drop files to upload to current remote directory
            </div>
          ) : null}
        </div>
      </div>
      </div>
    </>
  );
}

export default TerminalModal;
