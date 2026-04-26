"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const CustomError_1 = require("./CustomError");
const HttpStatusCode_1 = require("../utils/HttpStatusCode");
class HTTP403Error extends CustomError_1.CustomError {
    constructor({ message = 'Forbidden', details } = {}) {
        super(message, HttpStatusCode_1.HttpStatusCode.FORBIDDEN, true, details);
    }
}
exports.default = HTTP403Error;
//# sourceMappingURL=HTTP403Error.js.map