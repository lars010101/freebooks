with open("functions/src/index.js", "r") as f:
    code = f.read()

# Add 'period' to the module switch
old_switch = """      case 'settings':
        result = await handleSettings(ctx, action);
        break;"""
new_switch = """      case 'settings':
      case 'period':
        result = await handleSettings(ctx, action);
        break;"""

code = code.replace(old_switch, new_switch)

with open("functions/src/index.js", "w") as f:
    f.write(code)
