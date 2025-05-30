import argparse
from flask import Flask, render_template, request, redirect, url_for

app = Flask(__name__)
DEBUG_MODE = True

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/chat', methods=['GET', 'POST'])
def chat():
    if request.method == 'GET':
        return redirect(url_for('index'))
    elif request.method == 'POST':
        username = request.form.get('username')
        room_name = request.form.get('room_name')
        if not username or not room_name:
            # Handle cases where username or room_name might be missing, though 'required' in HTML should prevent this
            return redirect(url_for('index')) 
        return render_template('chat.html', username=username, room_name=room_name, DEBUG_MODE=DEBUG_MODE)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Flask Chat App')
    parser.add_argument('--port', type=int, default=5000, help='Port to run the server on')
    args = parser.parse_args()
    
    # Note: Flask's built-in server is not recommended for production.
    # Consider using a production-ready WSGI server like Gunicorn or uWSGI.
    # For simplicity in this example, we use the development server.
    # The 'debug=DEBUG_MODE' enables Flask's debugger if DEBUG_MODE is True.
    # 'host="0.0.0.0"' makes the server accessible from any network interface,
    # which is useful for testing from other devices on the same network.
    app.run(debug=DEBUG_MODE, host='0.0.0.0', port=args.port)
