import { ServerRequest } from "https://deno.land/std@0.62.0/http/server.ts";
import {
  JsonRpcRequest,
  JsonRpcResponseBasis,
  JsonRpcSuccess,
  JsonRpcFailure,
  JsonRpcId,
  JsonValue,
  JsonArray,
  JsonObject,
} from "./jsonRpc2Types.ts";
type ResultOrError =
  | { id: JsonRpcId | undefined; result: unknown }
  | ServerError;
type NotNotification =
  | { id: JsonRpcId; result: unknown }
  | (Omit<ServerError, "rpcRequestID"> & {
    rpcRequestID: JsonRpcId;
  });
type ResponseTypes =
  | (JsonRpcResponseBasis & { result: unknown })
  | JsonRpcFailure;
type Methods = { [method: string]: (...args: any[]) => unknown };

class ServerError extends Error {
  rpcErrorID: number;
  rpcRequestID: JsonRpcId | undefined;
  constructor(
    rpcErrorID: number,
    message: string,
    rpcRequestID: JsonRpcId | undefined,
  ) {
    super(message);
    this.rpcErrorID = rpcErrorID;
    this.rpcRequestID = rpcRequestID;
  }
}

function isJsonRpcVersion(input: unknown): input is "2.0" {
  return input === "2.0";
}
function isJsonRpcMethod(input: unknown): input is string {
  return typeof input === "string" && !input.startsWith("rpc.");
}
function isJsonRpcParams(input: unknown): input is JsonArray | JsonObject {
  return typeof input === "object";
}
function isJsonRpcId(input: unknown): input is JsonRpcId {
  switch (typeof input) {
    case "string":
      return true;
    case "number":
      return input % 1 === 0;
    case "object":
      let isNull = input === null;
      if (isNull) {
        console.warn("Use of null ID in JSONRPC 2.0 is discouraged.");
        return true;
      } else {
        return false;
      }
    default:
      return false;
  }
}

function validateRpcObj(
  decodedBody: JsonValue | ServerError,
  methods: Methods,
): JsonRpcRequest | ServerError {
  if (decodedBody instanceof ServerError) return decodedBody;
  if (
    typeof decodedBody === "object" &&
    !Array.isArray(decodedBody) &&
    decodedBody !== null
  ) {
    if (
      !isJsonRpcVersion(decodedBody.jsonrpc) ||
      !isJsonRpcMethod(decodedBody.method)
    ) {
      return new ServerError(
        -32600,
        "Invalid Request",
        isJsonRpcId(decodedBody.id) ? decodedBody.id : null,
      );
    } else if (typeof methods[decodedBody.method] !== "function") {
      return new ServerError(
        -32601,
        "Method not found",
        "id" in decodedBody
          ? isJsonRpcId(decodedBody.id) ? decodedBody.id : null
          : undefined,
      );
    } else if (
      "params" in decodedBody && !isJsonRpcParams(decodedBody.params)
    ) {
      return new ServerError(
        -32602,
        "Invalid parameters",
        "id" in decodedBody
          ? isJsonRpcId(decodedBody.id) ? decodedBody.id : null
          : undefined,
      );
    } else {
      return "id" in decodedBody
        ? isJsonRpcId(decodedBody.id)
          ? ((decodedBody as unknown) as JsonRpcRequest)
          : new ServerError(-32600, "Invalid Request", null)
        : ({ ...decodedBody, id: undefined } as JsonRpcRequest);
    }
  } else return new ServerError(-32600, "Invalid Request", null);
}

async function executeMethods(
  rpcReqObj: JsonRpcRequest | ServerError,
  methods: Methods,
  req?: ServerRequest,
): Promise<ResultOrError> {
  try {
    if (rpcReqObj instanceof ServerError) return rpcReqObj;
    else {
      if (req) {
        return Array.isArray(rpcReqObj.params)
          ? {
            result: await methods[rpcReqObj.method](req, ...rpcReqObj.params),
            id: rpcReqObj.id,
          }
          : {
            result: await methods[rpcReqObj.method]({
              ...rpcReqObj.params,
              req,
            }),
            id: rpcReqObj.id,
          };
      } else {
        return Array.isArray(rpcReqObj.params)
          ? {
            result: await methods[rpcReqObj.method](...rpcReqObj.params),
            id: rpcReqObj.id,
          }
          : {
            result: await methods[rpcReqObj.method](rpcReqObj.params),
            id: rpcReqObj.id,
          };
      }
    }
  } catch (err) {
    return new ServerError(
      -32000,
      "Server error",
      "id" in rpcReqObj
        ? isJsonRpcId(rpcReqObj.id) ? rpcReqObj.id : null
        : undefined,
    );
  }
}

async function respondRpc(
  req: ServerRequest,
  methods: Methods,
  { includeServerErrorStack = false, callMethodsWithRequestObj = false } = {},
) {
  const decodedBody = new TextDecoder().decode(await Deno.readAll(req.body));
  const resObject = callMethodsWithRequestObj
    ? await handleData(decodedBody, methods, includeServerErrorStack, req)
    : await handleData(decodedBody, methods, includeServerErrorStack);
  const headers = new Headers();
  headers.set("content-type", "application/json");
  req.respond(
    resObject
      ? {
        body: new TextEncoder().encode(JSON.stringify(resObject)),
        headers,
        status: 200,
      }
      : { status: 204 },
  );
  return resObject;
}

function parseJson(json: string): JsonValue | ServerError {
  try {
    return JSON.parse(json);
  } catch (err) {
    return new ServerError(-32700, "Parse error", null);
  }
}

async function handleData(
  decodedBody: string,
  methods: Methods,
  includeServerErrorStack = false,
  req?: ServerRequest,
): Promise<ResponseTypes | ResponseTypes[] | null> {
  const data = parseJson(decodedBody);
  const result: ResultOrError | ResultOrError[] =
    Array.isArray(data) && data.length > 0
      ? await Promise.all(
        data
          .map((body: JsonValue) => validateRpcObj(body, methods))
          .map((validatedRpcReq) =>
            req
              ? executeMethods(validatedRpcReq, methods, req)
              : executeMethods(validatedRpcReq, methods)
          ),
      )
      : req
      ? await executeMethods(validateRpcObj(data, methods), methods, req)
      : await executeMethods(validateRpcObj(data, methods), methods);
  return createRPCResponseObject(result, includeServerErrorStack);
}

function createRPCResponseObject(
  result: ResultOrError | ResultOrError[],
  includeServerErrorStack: boolean,
): ResponseTypes | ResponseTypes[] | null {
  if (Array.isArray(result)) {
    const responseBatchObj = result
      .map((result) => createObject(result, includeServerErrorStack))
      .filter(
        (result: ResponseTypes | null): result is ResponseTypes =>
          result != null,
      );
    return responseBatchObj.length > 0 ? responseBatchObj : null;
  } else {
    return createObject(result, includeServerErrorStack);
  }
}

function createObject(
  data: ResultOrError,
  includeServerErrorStack: boolean,
): ResponseTypes | null {
  function isNotNotification(result: ResultOrError): result is NotNotification {
    return (
      ("id" in result && result.id !== undefined) ||
      (result instanceof ServerError && result.rpcRequestID !== undefined)
    );
  }
  if (isNotNotification(data) && "id" in data) {
    return {
      jsonrpc: "2.0",
      result: data.result === undefined ? null : data.result, // can't return undefined
      id: data.id,
    };
  } else if (isNotNotification(data) && "rpcErrorID" in data) {
    const rpcResObj: JsonRpcFailure = {
      jsonrpc: "2.0",
      error: {
        code: data.rpcErrorID || -32603,
        message: data.message,
      },
      id: data.rpcRequestID,
    };
    if (data.stack && includeServerErrorStack) {
      rpcResObj.error.data = { stack: data.stack };
    }
    return rpcResObj;
  } else {
    return null;
  }
}

export { respondRpc, handleData, validateRpcObj };
