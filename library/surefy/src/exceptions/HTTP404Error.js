"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const CustomError_1 = require("./CustomError");
const HttpStatusCode_1 = require("../utils/HttpStatusCode");
class HTTP404Error extends CustomError_1.CustomError {
    constructor({ message = 'Resource Not Found', details } = {}) {
        super(message, HttpStatusCode_1.HttpStatusCode.NOT_FOUND, true, details);
    }
}
exports.default = HTTP404Error;
//# sourceMappingURL=HTTP404Error.js.map