import {
  ChannelModel,
  ConfirmChannel,
  connect,
  Connection,
  ConsumeMessage,
  Options,
} from "amqplib";
import dotenv from "dotenv";
import { config } from "../config";
import { NonRetryableError, describeError } from "../utils/safeError";

dotenv.config();

export const AGENT_EXCHANGE = "agent_exchange";

export interface SubscribeOptions {
  queueOptions?: Options.AssertQueue;
  /** Total deliveries before the message is dead-lettered. */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Messages this consumer handles at once (default 1). */
  prefetch?: number;
  /** Called once when a message is dead-lettered (retries exhausted or non-retryable). */
  onExhausted?: (message: unknown, error: unknown) => Promise<void>;
}

interface Subscription extends SubscribeOptions {
  queueName: string;
  routingKey: string;
  onMessage: (message: unknown) => Promise<void>;
}

const ATTEMPT_HEADER = "x-attempt";

class RabbitMQService {
  private static instance: RabbitMQService;
  private connection: Connection | null = null;
  private channel: ConfirmChannel | null = null;
  private model: ChannelModel | null = null;
  private reconnecting = false;
  private closing = false;
  private readonly subscriptions = new Map<string, Subscription>();

  private constructor() {}

  /**
   * Get the singleton instance of RabbitMQService
   * @returns The RabbitMQService instance
   */
  public static getInstance(): RabbitMQService {
    if (!RabbitMQService.instance) {
      RabbitMQService.instance = new RabbitMQService();
    }
    return RabbitMQService.instance;
  }

  /**
   * Connect to RabbitMQ
   * @returns Promise that resolves when connected
   */
  public async connect(): Promise<void> {
    if (this.connection) return;

    try {
      this.model = await connect(config.rabbitMqUrl);
      this.connection = this.model.connection;
      await this.openChannel();

      console.log("Connected to RabbitMQ");

      this.connection.on("error", (err) => {
        console.error(`RabbitMQ connection error: ${describeError(err)}`);
        this.reset();
        this.reconnect();
      });

      this.connection.on("close", () => {
        console.warn("RabbitMQ Connection Closed");
        this.reset();
        if (!this.closing) this.reconnect();
      });
    } catch (error) {
      console.error(`Failed to connect to RabbitMQ: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * Opens the channel and restores the subscriptions on it. The broker can
   * close a channel alone (e.g. a delivery not acknowledged within its
   * consumer timeout); without an "error" listener that crashes the process,
   * so the channel is reopened on the same connection instead.
   */
  private async openChannel(): Promise<void> {
    const model = this.model!;
    const channel = await model.createConfirmChannel();
    channel.on("error", (err) => {
      console.error(`RabbitMQ channel error: ${describeError(err)}`);
    });
    channel.on("close", () => {
      if (this.channel !== channel) return;
      this.channel = null;
      // A closing connection reconnects on its own; only a lone channel close is handled here.
      if (this.closing || this.model !== model) return;
      console.warn("RabbitMQ channel closed; reopening it");
      this.openChannel().catch((error) => {
        console.error(`Could not reopen the RabbitMQ channel: ${describeError(error)}`);
        void model.close().catch(() => undefined);
      });
    });
    await channel.assertExchange(AGENT_EXCHANGE, "topic", { durable: true });
    this.channel = channel;
    await this.restoreSubscriptions();
  }

  /**
   * Reset the connection state
   */
  private reset() {
    this.connection = null;
    this.channel = null;
    this.model = null;
  }

  /**
   * Reconnect to RabbitMQ
   */
  private async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;

    const maxRetries = 10;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      console.log(
        `RabbitMQ reconnect attempt ${attempt}/${maxRetries} in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        await this.connect();
        console.log("RabbitMQ reconnected successfully");
        this.reconnecting = false;
        return;
      } catch {
        // continue retrying
      }
    }

    this.reconnecting = false;
    console.error("RabbitMQ reconnection failed after max retries");
  }

  /**
   * Get the RabbitMQ channel
   * @returns The RabbitMQ channel
   * @throws Error if channel is not available
   */
  public async getChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      await this.connect();
    }
    if (!this.channel) {
      throw new Error("Could not establish RabbitMQ channel");
    }
    return this.channel;
  }
  /**
   * Check if the service is connected to RabbitMQ
   * @returns True if connected, false otherwise
   */
  public isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }

  /**
   * Publish a message to RabbitMQ
   * @param routingKey The routing key to publish to
   * @param message The message to publish
   * @param options Additional options for publishing
   * @returns Promise that resolves when the message is published
   */
  public async publish(
    routingKey: string,
    message: unknown,
    options: Options.Publish = {},
  ): Promise<void> {
    const channel = await this.getChannel();
    channel.publish(
      AGENT_EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      { persistent: true, contentType: "application/json", ...options },
    );
    await channel.waitForConfirms();
  }

  /**
   * Subscribe to a queue with a routing key
   * @param queueName The name of the queue to subscribe to
   * @param routingKey The routing key to subscribe to
   * @param onMessage The function to call when a message is received
   * @param queueOptions Additional options for the queue
   * @returns Promise that resolves when the subscription is established
   */
  public async subscribe(
    queueName: string,
    routingKey: string,
    onMessage: (message: unknown) => Promise<void>,
    options: SubscribeOptions = {},
  ): Promise<void> {
    const channel = await this.getChannel();
    const subscription = { queueName, routingKey, onMessage, ...options };
    this.subscriptions.set(queueName, subscription);
    await this.startSubscription(channel, subscription);
  }

  /**
   * Restore all subscriptions
   * @returns Promise that resolves when all subscriptions are restored
   */
  private async restoreSubscriptions(): Promise<void> {
    if (!this.channel) return;
    for (const subscription of this.subscriptions.values()) {
      await this.startSubscription(this.channel, subscription);
    }
  }

  /**
   * Start a subscription to a queue
   * @param channel The RabbitMQ channel
   * @param subscription The subscription to start
   * @returns Promise that resolves when the subscription is started
   */
  private async startSubscription(
    channel: ConfirmChannel,
    subscription: Subscription,
  ): Promise<void> {
    const { queueName } = subscription;
    const retryQueue = `${queueName}.retry`;
    const deadQueue = `${queueName}.dead`;
    await channel.assertQueue(queueName, {
      durable: true,
      ...subscription.queueOptions,
    });
    await channel.bindQueue(queueName, AGENT_EXCHANGE, subscription.routingKey);
    // Retry queue has no consumer: messages wait out the TTL and are
    // dead-lettered straight back to the work queue (default exchange).
    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        "x-message-ttl": subscription.retryDelayMs ?? config.consumerRetryDelayMs,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": queueName,
      },
    });
    await channel.assertQueue(deadQueue, { durable: true });
    await channel.prefetch(subscription.prefetch ?? 1);

    await channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        await this.handleDelivery(channel, subscription, msg);
      } catch (error) {
        // Never let a consumer callback reject (e.g. ack on a closed channel);
        // unacked messages are redelivered when the channel is re-established.
        console.error(
          `RabbitMQ delivery handling failed for ${queueName}: ${describeError(error)}`,
        );
      }
    });
  }

  private async handleDelivery(
    channel: ConfirmChannel,
    subscription: Subscription,
    msg: ConsumeMessage,
  ): Promise<void> {
    const { queueName } = subscription;
    let content: unknown;
    try {
      content = JSON.parse(msg.content.toString());
    } catch {
      console.error(`Dead-lettering malformed message from ${queueName}`);
      await this.sendToQueue(channel, `${queueName}.dead`, msg, {});
      channel.ack(msg);
      return;
    }

    try {
      await subscription.onMessage(content);
      channel.ack(msg);
      return;
    } catch (error) {
      const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1);
      const maxAttempts = subscription.maxAttempts ?? config.consumerMaxAttempts;
      const retryable = !(error instanceof NonRetryableError);
      console.error(
        `Consumer ${queueName} failed (attempt ${attempt}/${maxAttempts}): ${describeError(error)}`,
      );
      if (retryable && attempt < maxAttempts) {
        await this.sendToQueue(channel, `${queueName}.retry`, msg, {
          [ATTEMPT_HEADER]: attempt + 1,
        });
      } else {
        await this.sendToQueue(channel, `${queueName}.dead`, msg, {
          "x-error": describeError(error).slice(0, 1000),
        });
        if (subscription.onExhausted) {
          try {
            await subscription.onExhausted(content, error);
          } catch (hookError) {
            console.error(
              `onExhausted hook failed for ${queueName}: ${describeError(hookError)}`,
            );
          }
        }
      }
      channel.ack(msg);
    }
  }

  private async sendToQueue(
    channel: ConfirmChannel,
    queue: string,
    msg: ConsumeMessage,
    headers: Record<string, unknown>,
  ): Promise<void> {
    channel.sendToQueue(queue, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      headers: { ...msg.properties.headers, ...headers },
    });
    await channel.waitForConfirms();
  }

  /**
   * Close the RabbitMQ connection
   * @returns Promise that resolves when the connection is closed
   */
  public async close(): Promise<void> {
    this.closing = true;
    try {
      if (this.channel) await this.channel.close();
      if (this.model) await this.model.close();
    } catch (err) {
      console.error(`Error closing RabbitMQ connection: ${describeError(err)}`);
    } finally {
      this.reset();
      this.closing = false;
    }
  }
}

export default RabbitMQService.getInstance();
