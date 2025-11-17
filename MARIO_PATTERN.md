# Mario's Pattern

## Key Structure:
1. agentLoop receives initial user message
2. WHILE LOOP checks for tool calls
3. Calls streamAssistantResponse 
4. Executes tools
5. Adds tool results to context.messages
6. Loop continues with updated context
7. NO RECURSION

## Our Current Problem:
- We use RECURSION in transport.run()
- Each recursive call adds userMessage to context again
- This causes duplicates

## Solution:
Rewrite transport.run() to use while loop like Mario's agentLoop
