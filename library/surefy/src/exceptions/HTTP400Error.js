"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const CustomError_1 = require("./CustomError");
const HttpStatusCode_1 = require("../utils/HttpStatusCode");
class HTTP400Error extends CustomError_1.CustomError {
    constructor({ message = 'Bad Request', details } = {}) {
        super(message, HttpStatusCode_1.HttpStatusCode.BAD_REQUEST, true, details);
    }
}
exports.default = HTTP400Error;
//# sourceMappingURL=HTTP400Error.js.map