import { Request, Response } from 'express';
import { tryCatchAsync } from '@surefy/utils/Controller';
import facebookWebhookService from '../../services/facebookWebhook.service';

class FacebookWebhookController {
    verifyLeads = tryCatchAsync(
        async (req: Request, res: Response) => {
            const challenge = facebookWebhookService.verifyLeads({
                mode: req.query['hub.mode'],
                verifyToken: req.query['hub.verify_token'],
                challenge: req.query['hub.challenge'],
            });

            res.set('Cache-Control', 'no-store');

            return res
                .status(200)
                .type('text/plain')
                .send(challenge);
        },
    );

    receiveLeads = tryCatchAsync(
        async (
            req: Request & { rawBody?: Buffer },
            res: Response,
        ) => {
            await facebookWebhookService.receiveLeads(
                req.rawBody,
                req.get('X-Hub-Signature-256'),
            );

            return res
                .status(200)
                .type('text/plain')
                .send('EVENT_RECEIVED');
        },
    );

    verifyMessaging = tryCatchAsync(
        async (req: Request, res: Response) => {
            const challenge = facebookWebhookService.verifyMessaging({
                mode: req.query['hub.mode'],
                verifyToken: req.query['hub.verify_token'],
                challenge: req.query['hub.challenge']
            })
            res.set('Cache-control', 'no-store')
            return res.status(200).type('text/plain').send(challenge)
        }
    )

    receiveMessaging = tryCatchAsync(
        async (
            req: Request & { rawBody?: Buffer },
            res: Response,
        ) => {
            await facebookWebhookService.receiveMessaging(
                req.rawBody,
                req.get('X-Hub-Signature-256'),
            );

            return res
                .status(200)
                .type('text/plain')
                .send('EVENT_RECEIVED');
        },
    );



}

export default new FacebookWebhookController();