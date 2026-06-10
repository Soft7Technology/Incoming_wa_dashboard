import axios from 'axios';
import chatSessionModel from "@surefy/console/app/models/chatSession.model";
import { buildResponse } from "@surefy/console/utils";


export const executeNode = async ({
  bot,
  session,
  currentNode
}: any):Promise<any> => {
    if(!currentNode) return null;

    const data = currentNode.data
    const key = data?.key

    console.log("EXECUTING NODE:",key)

    /**
     * HTTP Node
     */
    if(key === "@http/http-request"){
        try{
            const response = await axios({
                method: data?.attributes?.method || "GET",
                url: data?.attributes?.url
            })

            const responseData = response.data;
            console.log("HTTP Response",responseData);

            //STORE Variables
            const updatedVariables = {
                ...(session.variables || {}),
                http_response:responseData
            }

            await chatSessionModel.update(session.id,{
                variables: updatedVariables
            })

            //FIND Next Node
            const edge = bot.edges.find(
                (e:any)=>e.source === currentNode.id
            );

            if(!edge) return null;

            const nextNode = bot.nodes.find(
                (n:any) => n.id === edge.target
            );

            if(!nextNode) return null;

            await chatSessionModel.update(session.id,{
                current_node_id : nextNode.id
            });

            return await executeNode({
                bot,
                session:{
                    ...session,
                    variables: updatedVariables,
                    current_node_id: nextNode.id
                },
                currentNode: nextNode
            })

        }catch(error:any){
           console.log("HTTP Error:", error?.response?.data)

           return{
            type:"text",
            text:"Something went wrong"
           }
        }
    }

    /**
     * CONDITION Node
     */
    if(key === "@condition/condition-action"){
        const conditions = data.attributes.conditions || [];

        const variables = session.variables || {};

        let evaluation = true;

        for(const condition of conditions){
            const variablePath = condition.field
                 .replace("{{","")
                 .replace("}}","");

            const actualValue = variablePath
                .split(".")
                .reduce(
                 (obj:any,key:string)=> obj?.[key],
                 variables
                );

            console.log("Actual Value",actualValue)
            
            const expectedValue = condition.value;
            if(condition.comparator === 'equals'){
                evaluation = 
                  String(actualValue).toLowerCase() === 
                  String(expectedValue).toLowerCase();
            }

            console.log("Expected Value",expectedValue)
        }
        console.log("CONDITION Result:", evaluation)

        const handle = evaluation 
         ? `condition-true-${currentNode.id}`
         : `condition-false-${currentNode.id}`

        console.log("Handle", handle)

        const edge = bot.edges.find(
            (e:any)=>
               e.source === currentNode.id && 
               String(e.data.condition) === String(evaluation)
        )

        console.log("Edge",edge)

        if(!edge) return null;

        const nextNode = bot.nodes.find(
            (n:any)=> n.id === edge.target
        );

        console.log("NextNode",nextNode)

        if(!nextNode) return null;

        await chatSessionModel.update(session.id,{
            current_node_id : nextNode.id,
        });

        return await executeNode({
            bot,
            session:{
                ...session,
                current_node_id: nextNode.id
            },
            currentNode:nextNode
        });
    }

    /**
     *  
    */

    /**
     * NORMAL Message NODES
    */
    return buildResponse(currentNode)
}