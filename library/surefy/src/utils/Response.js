"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendResponse = void 0;
const sendResponse = (res, statusCode, success, message, data, error) => {
    const response = Object.assign(Object.assign(Object.assign({ success,
        message }, (data && { data })), (error && { error })), { meta: {
            timestamp: new Date().toISOString(),
        } });
    return res.status(statusCode).json(response);
};
exports.sendResponse = sendResponse;
//# sourceMappingURL=Response.js.map