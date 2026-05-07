# Flask + FastAPI server fixture
from flask import Flask
from fastapi import APIRouter

app = Flask(__name__)
router = APIRouter()

@app.route('/users', methods=['GET'])
def list_users():
    return []

@app.route('/users', methods=['POST'])
def create_user():
    return {}

@app.get('/users/<int:user_id>')
def get_user(user_id):
    return {}

@router.get('/items')
async def list_items():
    return []

@router.post('/items')
async def create_item():
    return {}

@router.delete('/items/{item_id}')
async def delete_item(item_id):
    return {}
