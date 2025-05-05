import busboyInternal, { BusboyEvents } from "busboy";
import { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { Queue } from "./queue";

export namespace Busboy {
  export type Limits = {
    /**
     * Max field name size (in bytes).
     *
     * @default 100
     */
    fieldNameSize?: number | undefined;

    /**
     * Max field value size (in bytes).
     *
     * @default 1048576 (1MB)
     */
    fieldSize?: number | undefined;

    /**
     * Max number of non-file fields.
     *
     * @default Infinity
     */
    fields?: number | undefined;

    /**
     * For multipart forms, the max file size (in bytes).
     *
     * @default Infinity
     */
    fileSize?: number | undefined;

    /**
     * For multipart forms, the max number of file fields.
     *
     * @default Infinity
     */
    files?: number | undefined;

    /**
     * For multipart forms, the max number of parts (fields + files).
     *
     * @default Infinity
     */
    parts?: number | undefined;

    /**
     * For multipart forms, the max number of header key-value pairs to parse.
     *
     * @default 2000 (same as node's http module)
     */
    headerPairs?: number | undefined;
  };

  export type Config = {
    /**
     * 'highWaterMark' to use for the parser stream
     *
     * @default stream.Writable
     */
    highWaterMark?: number | undefined;

    /**
     * 'highWaterMark' to use for individual file streams
     *
     * @default stream.Readable
     */
    fileHwm?: number | undefined;

    /**
     * Default character set to use when one isn't defined.
     *
     * @default 'utf8'
     */
    defCharset?: string | undefined;

    /**
     * For multipart forms, the default character set to use for values of part header parameters (e.g. filename)
     * that are not extended parameters (that contain an explicit charset
     *
     * @default 'latin1'
     */
    defParamCharset?: string | undefined;

    /**
     * If paths in filenames from file parts in a 'multipart/form-data' request shall be preserved.
     *
     * @default false
     */
    preservePath?: boolean | undefined;

    /**
     * Various limits on incoming data.
     */
    limits?: Limits | undefined;
  };

  export type Info = {
    encoding: string;
    mimeType: string;
  };

  export type FileInfo = Info & {
    filename: string;
  };

  export type FieldInfo = Info & {
    nameTruncated: boolean;
    valueTruncated: boolean;
  };

  export type FileStream = Readable & { truncated?: boolean };
}

export type Source = NodeJS.ReadableStream & { headers?: IncomingHttpHeaders };

export type Config = Busboy.Config & {
  /**
   * Specifies the names of file fields that the generator should yield.
   * If this array is non-empty, only file events with names included in this list will be yielded.
   * File events with names *not* in this list will be automatically resumed and skipped by the wrapper,
   * preventing potential hangs from unhandled streams.
   * If this array is empty (the default), all file events will be yielded by the generator.
   *
   * @default []
   */
  allowedFileNames?: string[];
};

export type FieldEvent = {
  type: "field";
  name: string;
  value: string;
  info: Busboy.FieldInfo;
};

export type FieldsLimitEvent = {
  type: "fieldsLimit";
};

export type FileEvent = {
  type: "file";
  name: string;
  stream: Busboy.FileStream;
  info: Busboy.FileInfo;
};

export type FilesLimitEvent = {
  type: "filesLimit";
};

export type PartsLimitEvent = {
  type: "partsLimit";
};

export type Event =
  | FieldEvent
  | FieldsLimitEvent
  | FileEvent
  | FilesLimitEvent
  | PartsLimitEvent;

type CloseInternalEvent = { type: "close" };
type ErrorInternalEvent = { type: "error"; error: unknown };
type InternalEvent = Event | CloseInternalEvent | ErrorInternalEvent;

export async function* busboy(source: Source, config?: Config) {
  const queue = new Queue<InternalEvent>();

  let resolver: (() => void) | null = null;
  let waiter: Promise<void> = new Promise((resolve) => (resolver = resolve));

  const notify = (event: InternalEvent) => {
    queue.push(event);

    if (resolver) {
      resolver();
      waiter = new Promise((resolve) => (resolver = resolve));
    }
  };

  const onClose: BusboyEvents["close"] = () => notify({ type: "close" });
  const onError: BusboyEvents["error"] = (error) =>
    notify({ type: "error", error });
  const onField: BusboyEvents["field"] = (name, value, info) =>
    notify({ type: "field", name, value, info });
  const onFieldsLimit: BusboyEvents["fieldsLimit"] = () =>
    notify({ type: "fieldsLimit" });
  const onFilesLimit: BusboyEvents["filesLimit"] = () =>
    notify({ type: "filesLimit" });
  const onPartsLimit: BusboyEvents["partsLimit"] = () =>
    notify({ type: "partsLimit" });

  const allowedFileNames = config?.allowedFileNames ?? [];
  const onFile: BusboyEvents["file"] = (name, stream, info) => {
    if (allowedFileNames.length === 0 || allowedFileNames.includes(name)) {
      notify({ type: "file", name, stream, info });
    } else {
      stream.resume();
    }
  };

  delete config?.allowedFileNames;
  const busboy = busboyInternal({
    ...(config ?? {}),
    headers: source.headers,
  });

  const yieldedFileStreams: Busboy.FileStream[] = [];
  try {
    busboy.on("close", onClose);
    busboy.on("error", onError);
    busboy.on("field", onField);
    busboy.on("fieldsLimit", onFieldsLimit);
    busboy.on("file", onFile);
    busboy.on("filesLimit", onFilesLimit);
    busboy.on("partsLimit", onPartsLimit);

    source.pipe(busboy);

    while (true) {
      if (!queue.isEmpty()) {
        const event = queue.pop();
        if (event.type === "close") {
          break;
        } else if (event.type === "error") {
          throw event.error;
        } else if (event.type === "file") {
          yieldedFileStreams.push(event.stream);
          yield event;
        } else {
          yield event;
        }
      } else {
        await waiter;
      }
    }
  } finally {
    try {
      source.unpipe(busboy);
    } catch (_e) {}

    try {
      if (source.readable) {
        source.resume();
      }
    } catch (_e) {}

    busboy.off("close", onClose);
    busboy.off("error", onError);
    busboy.off("field", onField);
    busboy.off("fieldsLimit", onFieldsLimit);
    busboy.off("file", onFile);
    busboy.off("filesLimit", onFilesLimit);
    busboy.off("partsLimit", onPartsLimit);

    for (const stream of yieldedFileStreams) {
      try {
        if (!stream.closed || !stream.destroyed) {
          stream.once("error", () => {});
          stream.resume();
          stream.destroy();
        }
      } catch (_e) {}
    }

    if (!busboy.destroyed) {
      busboy.once("error", () => {});
      busboy.end();
      busboy.destroy();
    }
  }
}
