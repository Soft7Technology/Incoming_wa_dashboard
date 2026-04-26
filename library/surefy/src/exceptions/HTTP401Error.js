"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const CustomError_1 = require("./CustomError");
const HttpStatusCode_1 = require("../utils/HttpStatusCode");
class HTTP401Error extends CustomError_1.CustomError {
    constructor({ message = 'Unauthorized', details } = {}) {
        super(message, HttpStatusCode_1.HttpStatusCode.UNAUTHORIZED, true, details);
    }
}
exports.default = HTTP401Error;
//# sourceMappingURL=HTTP401Error.js.map