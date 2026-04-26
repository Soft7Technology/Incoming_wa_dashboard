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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPlanLimit = void 0;
const userPlans_model_1 = __importDefault(require("@surefy/console/app/models/userPlans.model"));
const checkPlanLimit = (type) => {
    return (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b, _c;
        const userId = req.userId;
        console.log("UserId", userId);
        const plan = yield userPlans_model_1.default.getPlanByUserId(userId);
        if (!plan) {
            // throw new HTTP401Error({ message: 'User Plan Not found or inactive' });
            return res.status(403).json({ message: 'No Active plan found. Subscribe to use Latest Features' });
        }
        const now = new Date();
        if (now < plan.start_date || now > plan.end_date) {
            // throw new HTTP401Error({ message: 'User Plan Expired' });
            return res.status(403).json({ message: `User ${plan.plan_name} Plan Expired` });
        }
        // ✅ JSON-based logic
        const limit = ((_b = (_a = plan.limits) === null || _a === void 0 ? void 0 : _a[type]) === null || _b === void 0 ? void 0 : _b.limit) || 0;
        const used = ((_c = plan.usage) === null || _c === void 0 ? void 0 : _c[type]) || 0;
        console.log("Used, Limit", used, limit);
        if (used >= limit) {
            return res.status(403).json({
                message: `${type} Type Plan limit reached`
            });
            // return successResponse(req, res, `${type} Plan limit reached`, HttpStatusCode.OK);
        }
        next();
    });
};
exports.checkPlanLimit = checkPlanLimit;
//# sourceMappingURL=plan.middleware.js.map