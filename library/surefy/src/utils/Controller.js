"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorResponse = exports.successResponse = exports.tryCatchAsync = void 0;
const HttpStatusCode_1 = require("./HttpStatusCode");
const Response_1 = require("./Response");
const tryCatchAsync = (fn) => {
    return (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield fn(req, res, next);
        }
        catch (error) {
            next(error);
        }
    });
};
exports.tryCatchAsync = tryCatchAsync;
const successResponse = (req, res, message, data, statusCode = HttpStatusCode_1.HttpStatusCode.OK) => {
    return (0, Response_1.sendResponse)(res, statusCode, true, message, data);
};
exports.successResponse = successResponse;
const errorResponse = (req, res, message, error, statusCode = HttpStatusCode_1.HttpStatusCode.INTERNAL_SERVER_ERROR) => {
    return (0, Response_1.sendResponse)(res, statusCode, false, message, undefined, error);
};
exports.errorResponse = errorResponse;
//# sourceMappingURL=Controller.js.map