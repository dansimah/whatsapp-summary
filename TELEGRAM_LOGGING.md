# Telegram Logging Configuration Guide

This guide explains how to configure which log messages are sent to your Telegram status group.

## Overview

The bot now supports granular control over which log messages are sent to Telegram. You can configure:
- **Global log levels** (affects all services)
- **Service-specific log levels** (overrides global settings)
- **Which services to monitor**
- **Message length limits**

## Configuration Options

### Basic Configuration

In your `config.json`, under the `logging.telegram` section:

```json
{
  "logging": {
    "telegram": {
      "enabled": true,
      "enabledLevels": ["error", "warn", "info"],
      "enabledServices": ["*"],
      "serviceFilters": {
        "whatsapp": ["error", "warn", "info"],
        "telegram": ["error", "warn"],
        "gemini": ["error", "warn"],
        "database": ["error", "warn"]
      },
      "maxMessageLength": 4000,
      "includeDebug": false
    }
  }
}
```

### Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable Telegram logging |
| `enabledLevels` | array | `["error", "warn"]` | Global log levels to send to Telegram |
| `enabledServices` | array | `["*"]` | Services to monitor (`["*"]` = all services) |
| `serviceFilters` | object | `{}` | Service-specific log level filters |
| `maxMessageLength` | number | `4000` | Maximum message length for Telegram |
| `includeDebug` | boolean | `false` | Whether to include debug messages |

### Available Log Levels

- `"error"` - Critical errors and exceptions
- `"warn"` - Warnings and potential issues
- `"info"` - General information messages
- `"debug"` - Detailed debugging information

### Available Services

- `"whatsapp"` - WhatsApp service messages
- `"telegram"` - Telegram bot service messages
- `"gemini"` - Gemini AI service messages
- `"database"` - Database service messages

## Configuration Examples

### Example 1: Everything to Telegram (Current Setting)

```json
{
  "logging": {
    "telegram": {
      "enabled": true,
      "enabledLevels": ["error", "warn", "info"],
      "enabledServices": ["*"],
      "serviceFilters": {
        "whatsapp": ["error", "warn", "info"],
        "telegram": ["error", "warn"],
        "gemini": ["error", "warn"],
        "database": ["error", "warn"]
      }
    }
  }
}
```

**Result:** 
- WhatsApp: All info, warnings, and errors
- Other services: Only warnings and errors

### Example 2: Warnings and Errors Only

```json
{
  "logging": {
    "telegram": {
      "enabled": true,
      "enabledLevels": ["error", "warn"],
      "enabledServices": ["*"]
    }
  }
}
```

**Result:** All services send only warnings and errors to Telegram.

### Example 3: WhatsApp Only

```json
{
  "logging": {
    "telegram": {
      "enabled": true,
      "enabledLevels": ["error", "warn"],
      "enabledServices": ["whatsapp"]
    }
  }
}
```

**Result:** Only WhatsApp service messages are sent to Telegram.

### Example 4: Service-Specific Configuration

```json
{
  "logging": {
    "telegram": {
      "enabled": true,
      "enabledLevels": ["error"],
      "enabledServices": ["*"],
      "serviceFilters": {
        "whatsapp": ["error", "warn", "info"],
        "telegram": ["error"],
        "gemini": ["error", "warn"],
        "database": ["error"]
      }
    }
  }
}
```

**Result:**
- WhatsApp: Info, warnings, and errors
- Telegram: Only errors
- Gemini: Warnings and errors
- Database: Only errors

### Example 5: Disable Telegram Logging

```json
{
  "logging": {
    "telegram": {
      "enabled": false
    }
  }
}
```

**Result:** No log messages are sent to Telegram.

## Message Format

Telegram messages are formatted as:

```
📋 ERROR [WhatsApp]
Error loading historical messages from תושבים שער השומרון 1
⏰ 2025-06-25 15:17:30
📊 ```
{
  "error": "Evaluation failed: TypeError: Cannot read properties of undefined (reading '_serialized')"
}
```
```

## Dynamic Configuration

You can also change the configuration programmatically:

```javascript
const logger = require('./utils/logger');

// Configure everything to Telegram
logger.configureTelegramLogging({
  enabledLevels: ['error', 'warn', 'info'],
  enabledServices: ['*'],
  serviceFilters: {
    whatsapp: ['error', 'warn', 'info'],
    telegram: ['error', 'warn'],
    gemini: ['error', 'warn'],
    database: ['error', 'warn']
  }
});

// Or configure individual aspects
logger.setTelegramLevels(['error', 'warn']);
logger.setTelegramServices(['whatsapp', 'telegram']);
logger.setTelegramServiceFilters({
  whatsapp: ['error', 'warn', 'info'],
  telegram: ['error']
});
```

## Best Practices

1. **Start with everything enabled** to see what's happening
2. **Gradually reduce noise** by limiting to warnings and errors
3. **Use service-specific filters** to fine-tune per service
4. **Monitor message length** - very long messages may be truncated
5. **Avoid debug messages** in production to prevent spam

## Troubleshooting

### No messages in Telegram
- Check if `enabled` is set to `true`
- Verify `enabledServices` includes the service you're monitoring
- Ensure the log level is included in `enabledLevels` or service-specific filters

### Too many messages
- Reduce `enabledLevels` to `["error", "warn"]`
- Use service-specific filters to limit certain services
- Set `enabledServices` to specific services instead of `["*"]`

### Messages too long
- Reduce `maxMessageLength` (default: 4000 characters)
- Long metadata will be automatically truncated 