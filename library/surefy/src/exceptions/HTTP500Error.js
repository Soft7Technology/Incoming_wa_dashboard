"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const CustomError_1 = require("./CustomError");
const HttpStatusCode_1 = require("../utils/HttpStatusCode");
class HTTP500Error extends CustomError_1.CustomError {
    constructor({ message = 'Internal Server Error', details } = {}) {
        super(message, HttpStatusCode_1.HttpStatusCode.INTERNAL_SERVER_ERROR, false, details);
    }
}
exports.default = HTTP500Error;
//# sourceMappingURL=HTTP500Error.js.map