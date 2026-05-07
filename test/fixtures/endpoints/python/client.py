import requests
import httpx

def fetch_users():
    return requests.get('/users')

def get_user(user_id):
    return requests.get(f'/users/{user_id}')

def create_user(data):
    return requests.post('/users', json=data)

async def fetch_items():
    async with httpx.AsyncClient() as client:
        return await client.get('/items')

async def get_item(item_id):
    async with httpx.AsyncClient() as client:
        return await client.get(f'/items/{item_id}')
