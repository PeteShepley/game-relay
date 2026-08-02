import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda'
import { handleConnect, handleDisconnect, handleMessage } from './relay'
import { DynamoRoomStore } from './store'
import type { Send, WireMessage } from './protocol'

// Reused across warm invocations.
const store = new DynamoRoomStore(process.env.ROOMS_TABLE ?? 'gin-rummy-rooms')
const managementClients = new Map<string, ApiGatewayManagementApiClient>()

const ok: APIGatewayProxyResultV2 = { statusCode: 200, body: '' }

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const { routeKey, connectionId } = event.requestContext

  try {
    const sends = await route(event, routeKey, connectionId)
    await deliver(event, sends)
  } catch (err) {
    console.error('relay error', { routeKey, connectionId, err })
    // Still 200: a 500 makes API Gateway drop the socket, which would strand
    // an otherwise healthy game on a transient store hiccup.
  }
  return ok
}

async function route(
  event: APIGatewayProxyWebsocketEventV2,
  routeKey: string,
  connectionId: string,
): Promise<Send[]> {
  if (routeKey === '$connect') return handleConnect()
  if (routeKey === '$disconnect') return handleDisconnect(store, connectionId)

  const message = parse(event.body)
  if (!message) return []
  return handleMessage(store, connectionId, message)
}

function parse(body: string | undefined): WireMessage | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.kind === 'string' ? (parsed as WireMessage) : null
  } catch {
    return null
  }
}

async function deliver(event: APIGatewayProxyWebsocketEventV2, sends: Send[]): Promise<void> {
  if (sends.length === 0) return
  const client = managementClient(event)
  await Promise.all(
    sends.map(async (send) => {
      try {
        await client.send(
          new PostToConnectionCommand({
            ConnectionId: send.connectionId,
            Data: Buffer.from(JSON.stringify(send.message)),
          }),
        )
      } catch (err) {
        // A gone connection just means that player dropped; its own
        // $disconnect handles the seat cleanup, so swallow it here.
        if ((err as { name?: string }).name !== 'GoneException') {
          console.error('post failed', { to: send.connectionId, err })
        }
      }
    }),
  )
}

// The Management API must target the execute-api endpoint, NOT the client's
// custom domain: apiId.execute-api.<region>.amazonaws.com/<stage>.
function managementClient(event: APIGatewayProxyWebsocketEventV2): ApiGatewayManagementApiClient {
  const { apiId, stage } = event.requestContext
  const region = process.env.AWS_REGION ?? 'us-east-1'
  const endpoint = `https://${apiId}.execute-api.${region}.amazonaws.com/${stage}`
  let client = managementClients.get(endpoint)
  if (!client) {
    client = new ApiGatewayManagementApiClient({ endpoint })
    managementClients.set(endpoint, client)
  }
  return client
}
