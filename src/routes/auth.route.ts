import { Router } from 'express';
import { jwtAuthMiddleware, requireRole } from '@surefy/middleware/jwtAuth.middleware';
import AuthController from '@surefy/console/http/controllers/auth.controller';
import teamController from '../app/http/controllers/team.controller';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';


const AuthRoute = Router();
  
// Public routes (no authentication required)
AuthRoute.post('/login', AuthController.login);
AuthRoute.post('/register', AuthController.register); 
AuthRoute.post('/register-company', AuthController.onboard);
AuthRoute.post('/setup-password', teamController.setUpPassword )
AuthRoute.post('/media', uploadMediaMiddleware, AuthController.uploadMedia);

//Reset-password
AuthRoute.post('/verify-otp', AuthController.verifyOtp);
AuthRoute.post('/reset-password', AuthController.forgotPassword);
AuthRoute.post('/send-otp', AuthController.sendOtp);

// Protected routes (JWT authentication required)
AuthRoute.get('/profile', jwtAuthMiddleware, AuthController.getProfile);
AuthRoute.post('/change-password', jwtAuthMiddleware, AuthController.changePassword);

// Admin routes (superadmin only)
AuthRoute.post(
  '/create-admin',
  jwtAuthMiddleware,
  requireRole('superadmin'),
  AuthController.createAdmin
);

export default AuthRoute;



