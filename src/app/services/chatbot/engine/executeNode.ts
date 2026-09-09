import axios from 'axios';
import chatSessionModel from "@surefy/console/app/models/chatSession.model";
import { buildResponse } from "@surefy/console/utils";
import { replaceVariables } from '@surefy/console/utils';
import contactTagModel from '@surefy/console/app/models/contactTag.model';
import contactModel from '@surefy/console/app/models/contact.model';
import contactTagRelationModel from '@surefy/console/app/models/contactTagRelation.model';
import columnModel from '@surefy/console/app/models/column.model';


export const endSession = async (
    sessionId: string
): Promise<void> => {
    await chatSessionModel.update(sessionId, {
        active: false,
        current_node_id: null,
        completed_at: new Date(),
    });
};

export const executeNode = async ({
    bot,
    session,
    currentNode
}: any): Promise<any> => {
    if (!currentNode) return null;

    const data = currentNode.data
    const key = data?.key

    console.log("EXECUTING NODE:", key, data, session)

    /**
     * HTTP Node
     */
    if (key === "@http/http-request") {
        try {

            let requestBody = data?.attributes?.body;
            let requestHeaders = data?.attributes?.headers || {};
            let requestParams = data?.attributes?.params || {};

            // Parse body
            if (typeof requestBody === "string") {
                try {
                    requestBody = JSON.parse(requestBody);
                } catch {
                    // Keep as raw string
                }
            }

            // Parse headers
            if (typeof requestHeaders === "string") {
                try {
                    requestHeaders = JSON.parse(requestHeaders);
                } catch {
                    requestHeaders = {};
                }
            }

            // Parse params
            if (typeof requestParams === "string") {
                try {
                    requestParams = JSON.parse(requestParams);
                } catch {
                    requestParams = {};
                }
            }

            console.log("Session", session.variables)

            // Replace variables
            requestBody = replaceVariables(
                requestBody,
                session.variables || {}
            );

            requestHeaders = replaceVariables(
                requestHeaders,
                session.variables || {}
            );

            requestParams = replaceVariables(
                requestParams,
                session.variables || {}
            );

            /**
             * Convert
             * [
             *   { key: "Content-Type", value: "application/json" }
             * ]
             *
             * =>
             *
             * {
             *   "Content-Type":"application/json"
             * }
             */
            if (Array.isArray(requestHeaders)) {
                requestHeaders = requestHeaders.reduce(
                    (acc: Record<string, any>, item: any) => {
                        if (
                            item &&
                            typeof item.key === "string" &&
                            item.key.trim()
                        ) {
                            acc[item.key] = item.value;
                        }
                        return acc;
                    },
                    {}
                );
            }

            console.log("HTTP REQUEST");
            console.log({
                method: data?.attributes?.method || "GET",
                url: data?.attributes?.url,
                headers: requestHeaders,
                params: requestParams,
                body: requestBody
            });

            const response = await axios({
                method: data?.attributes?.method || "GET",
                url: data?.attributes?.url,
                headers: requestHeaders,
                params: requestParams,
                data: requestBody,
                timeout: 30000,
                validateStatus: () => true
            });

            console.log("HTTP STATUS:", response.status);
            console.log("HTTP RESPONSE:", response.data);

            // Treat non-success status as error
            if (response.status >= 400) {
                throw new Error(
                    `Request failed with status ${response.status}`
                );
            }

            const updatedVariables = {
                ...(session.variables || {}),
                http_response: response.data,
                http_status: response.status,
                http_headers: response.headers
            };

            console.log('Update variables', updatedVariables)

            const edge = bot.edges.find(
                (e: any) => e.source === currentNode.id
            );

            if (!edge) {
                await endSession(session.id);
                console.log(
                    "No outgoing edge found from HTTP node"
                );
                return null;
            }

            const nextNode = bot.nodes.find(
                (n: any) => n.id === edge.target
            );

            if (!nextNode) {
                console.log("Next node not found");
                return null;
            }

            await chatSessionModel.update(session.id, {
                current_node_id: nextNode.id,
                variables: updatedVariables
            });

            return await executeNode({
                bot,
                session: {
                    ...session,
                    current_node_id: nextNode.id,
                    variables: updatedVariables
                },
                currentNode: nextNode
            });

        } catch (error: any) {

            console.error("HTTP NODE ERROR");

            if (error.response) {
                console.error("Status:", error.response.status);
                console.error("Data:", error.response.data);
            }

            console.error("Message:", error.message);

            const updatedVariables = {
                ...(session.variables || {}),
                http_error: error.message
            };

            await chatSessionModel.update(session.id, {
                variables: updatedVariables
            });

            return {
                type: "text",
                text: "Something went wrong"
            };
        }
    }

    /**
     * CONDITION Node
     */
    if (key === "@condition/condition-action") {
        // const conditions = data.attributes.conditions || [];
        let updateVariable: any = {};
        const conditionVariable = data?.attributes?.variable || "";

        const variables = session.variables || {};
        console.log("Condition variabes", variables)

        console.log("condition Variable", conditionVariable)

        if (conditionVariable) {
            const value = variables?.http_response?.data[
                conditionVariable
            ]

            console.log("Condition Value", value)

            if (value !== undefined) {
                updateVariable[conditionVariable] = value;
            }
        }

        // const mergedVariables = {
        //     ...variables,
        //     ...updateVariable
        // }

        const mergedVariables = {
            ...variables,

            api_response: variables?.http_response,

            gstin:
                variables?.http_response?.data?.gstin,

            data: {
                company_details: variables?.http_response
                    ? variables?.http_response?.data?.company_details
                    : null,
            },

            valid:
                variables?.http_response?.data?.valid,

            // company_details:
            //     variables.http_response?.data?.company_details,
            // phone_number: variables.phone_number
            //     ?? variables.http_response?.data?.phone_number
            details: {
                company_details: variables?.http_response
                    ? variables?.http_response?.data?.company_details
                    : null,
                gstin: variables?.gstin,
                email: variables?.email,
                name: variables?.name,
                role: variables?.role || "fpo",
                photo: variables?.photo,
                location: {
                    latitude: variables?.latitude,
                    longitude: variables?.longitude,
                },
                phone_number: variables?.phone_number,
                parent_user_id: variables?.parent_user_id
            }

        };
        console.log("Merged Variable", mergedVariables)

        const success = variables?.http_response?.success === true
        console.log("HTTP Success", success)


        // let evaluation = true;

        // for(const condition of conditions){
        //     const variablePath = condition.field
        //          .replace("{{","")
        //          .replace("}}","");

        //     const actualValue = variablePath
        //         .split(".")
        //         .reduce(
        //          (obj:any,key:string)=> obj?.[key],
        //          variables
        //         );

        //     console.log("Actual Value",actualValue)
        //     console.log("Condition",condition)

        //     const expectedValue = condition.value;
        //     if(condition.comparator === 'equals'){
        //         evaluation = 
        //           String(actualValue).toLowerCase() === 
        //           String(expectedValue).toLowerCase();
        //     }

        //     console.log("Expected Value",expectedValue)
        // }
        // console.log("CONDITION Result:", evaluation)

        // const handle = evaluation 
        //  ? `condition-true-${currentNode.id}`
        //  : `condition-false-${currentNode.id}`

        // console.log("Handle", handle)

        const edge = bot.edges.find(
            (e: any) =>
                e.source === currentNode.id &&
                String(e.data.condition) === String(success)
        )

        console.log("Edge", edge)

        if (!edge) return null;

        const nextNode = bot.nodes.find(
            (n: any) => n.id === edge.target
        );

        console.log("NextNode", nextNode)

        if (!nextNode) return null;

        await chatSessionModel.update(session.id, {
            variables: mergedVariables,
            current_node_id: nextNode.id,
        });

        return await executeNode({
            bot,
            session: {
                ...session,
                current_node_id: nextNode.id,
                variables: mergedVariables
            },
            currentNode: nextNode
        });
    }

    /**
     *  
    */

    /**
     * NORMAL Message NODES
    */
    const response = await buildResponse(currentNode, session, bot);
    if (response?.stopChatbot) {
        console.log(
            "Session ended:",
            session.id
        );

        return response;
    }


    // ----------------------------------------
    // UPDATE CONTACT TAGS
    // ----------------------------------------

    if (key === "@whatsapp/update-tag") {
        try {
            const tags =
                data?.attributes?.tags || [];

            if (!Array.isArray(tags) || tags.length === 0) {
                console.log("No tags provided");
                return null;
            }

            console.log('Sessions variable',session)

            const phone = session?.phone_number;
            const userId = session?.variables?.user_id ?? bot?.user_id;

            if (!phone) {
                console.log(
                    "Phone number not found in session"
                );
                return null;
            }

            console.log("Updating tags:", {
                phone,
                tags,
            });

            // Get the contact
            if (!userId) {
                console.log("Bot owner user_id not found");
                return null;
            }

            const contact =
                await contactModel.findByPhone(
                    userId,
                    phone
                );

            if (!contact) {
                console.log(
                    "Contact not found for:",
                    phone
                );
                return null;
            }

            // Add tags to contact
            await contactTagRelationModel.bulkAddTags(
                contact.user_id,
                contact.id,
                tags
            );

            console.log(
                "Tags updated successfully"
            );

            // ----------------------------------------
            // Continue to next node
            // ----------------------------------------

            const edge = bot.edges.find(
                (e: any) =>
                    e.source === currentNode.id
            );

            if (!edge) {
                await endSession(session.id);

                return null;
            }

            const nextNode = bot.nodes.find(
                (n: any) =>
                    n.id === edge.target
            );

            if (!nextNode) {
                await endSession(session.id);

                return null;
            }

            await chatSessionModel.update(
                session.id,
                {
                    current_node_id: nextNode.id,
                }
            );

            return await executeNode({
                bot,
                session: {
                    ...session,
                    current_node_id: nextNode.id,
                },
                currentNode: nextNode,
            });

        } catch (error: any) {
            console.error(
                "UPDATE TAG NODE ERROR:",
                error
            );

            return null;
        }
    }

    // ---------------------------------------
    // Update Contact
    // --------------------------------------
    if (key === "@whatsapp/update-column") {
        try {
            const updates = data?.attributes?.columnUpdates || [];

            console.log("Update column", updates);

            if (!updates.length) {
                console.log("No column updates provided");
                return null;
            }

            const phone = session?.variables?.phone_number;

            if (!phone) {
                console.log("Phone number not found");
                return null;
            }

            const contact = await contactModel.findByUserPhoneNumber(phone);

            if (!contact) {
                console.log("Contact not found");
                return null;
            }

            const customFields = {
                ...(contact.custom_fields || {}),
            };

            for (const update of updates) {
                const column = update?.column;
                const value = update?.value;

                if (!column) {
                    console.log("Column missing");
                    continue;
                }

                customFields[column] = value;
            }

            await contactModel.update(contact.id, {
                custom_fields: customFields,
            });

            console.log("Contact custom fields updated", {
                contactId: contact.id,
                customFields,
            });

            const edge = bot.edges.find(
                (e: any) => e.source === currentNode.id
            );

            if (!edge) {
                await endSession(session.id);
                return null;
            }

            const nextNode = bot.nodes.find(
                (n: any) => n.id === edge.target
            );

            if (!nextNode) {
                await endSession(session.id);
                return null;
            }

            await chatSessionModel.update(session.id, {
                current_node_id: nextNode.id,
            });

            return await executeNode({
                bot,
                session: {
                    ...session,
                    current_node_id: nextNode.id,
                },
                currentNode: nextNode,
            });

        } catch (error) {
            console.error("UPDATE COLUMN ERROR:", error);
            return null;
        }
    }

    // Text nodes, such as the welcome message, do not wait for user input.
    // Follow their outgoing edge immediately and persist the next node.
    if (key !== "@whatsapp/send-text-message") return response;

    const edge = bot.edges.find(
        (e: any) => e.source === currentNode.id
    );

    if (!edge) {

        // await chatSessionModel.update(session.id, {
        //     active: false,
        //     current_node_id: null,
        //     completed_at: new Date()
        // });
        await endSession(session.id);

        return response;
    }

    const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
    if (!nextNode) return response;

    await chatSessionModel.update(session.id, { current_node_id: nextNode.id });

    const nextResponse = await executeNode({
        bot,
        session: { ...session, current_node_id: nextNode.id },
        currentNode: nextNode,
    });

    const messages = (result: any) => result?.messages || (result ? [result] : []);
    return { messages: [...messages(response), ...messages(nextResponse)] };
}
