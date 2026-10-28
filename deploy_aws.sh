#!/usr/bin/env bash
set -euo pipefail

EC2_USER="admin"
EC2_HOST="18.221.114.95"
SSH_KEY="/Users/marcus/Documents/cronserver.pem"
REMOTE_DIR="/home/admin/life_journey"

echo "1/3 Syncing life_journey to AWS EC2 ($EC2_USER@$EC2_HOST:$REMOTE_DIR)..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$EC2_USER@$EC2_HOST" "mkdir -p $REMOTE_DIR"
rsync -az --delete \
  --exclude=".git" \
  --exclude="scratch" \
  --exclude=".DS_Store" \
  --exclude="*.orig" \
  --exclude="*.patch" \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  ./ "$EC2_USER@$EC2_HOST:$REMOTE_DIR/"

if [ -f .env ]; then
  echo "2/3 Uploading .env to AWS EC2..."
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=no .env "$EC2_USER@$EC2_HOST:$REMOTE_DIR/.env"
fi

echo "3/3 Starting/restarting PM2 service life_journey (Port 8082)..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$EC2_USER@$EC2_HOST" "
  export PATH=\$PATH:/usr/local/bin:~/.nvm/versions/node/\$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin
  cd $REMOTE_DIR
  PORT=8082 NODE_ENV=production pm2 describe life_journey >/dev/null 2>&1 \
    && PORT=8082 NODE_ENV=production pm2 restart life_journey --update-env \
    || PORT=8082 NODE_ENV=production pm2 start server.js --name life_journey
  pm2 save
"

echo "✅ Deployed life_journey (Port 8082) to AWS EC2 ($EC2_HOST)!"
