import { createLogger } from 'sonant'
import { ConsoleSink } from 'sonant/sinks/console'
import { SeqSink } from 'sonant/sinks/seq'

export const logger = createApplicationLogger()

/** Sinks expect an Error; upstream libraries sometimes reject with other values. */
export function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

export function createApplicationLogger(
  environment: Record<string, string | undefined> = process.env,
) {
  const consoleSink = new ConsoleSink()
  const consoleLogger = createLogger({ sinks: [consoleSink] }).with({
    Application: 'CoStack',
  })
  const serverUrl = environment.SEQ_URL?.trim()
  if (!serverUrl) return consoleLogger

  const apiKey = environment.SEQ_API_KEY?.trim()
  return createLogger({
    sinks: [
      consoleSink,
      new SeqSink({
        serverUrl,
        ...(apiKey ? { apiKey } : {}),
        onError: (error) =>
          consoleLogger.error(
            new Error('Seq delivery failed', { cause: error }),
            'Failed to deliver logs to Seq',
          ),
      }),
    ],
    selfLog: (error, context) =>
      consoleLogger.error(
        new Error('Logging failed', { cause: error }),
        'Logging failed during {Operation}',
        { Operation: context.operation },
      ),
  }).with({ Application: 'CoStack' })
}
