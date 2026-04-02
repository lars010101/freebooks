with open("functions/src/index.js", "r") as f:
    code = f.read()

code = code.replace("\\`", "`")

with open("functions/src/index.js", "w") as f:
    f.write(code)
